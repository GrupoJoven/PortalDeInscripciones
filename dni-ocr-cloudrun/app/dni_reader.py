from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps
from paddleocr import PaddleOCR


# =============================================================================
# Utilidades generales
# =============================================================================

DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"
CARD_RATIO = 85.60 / 53.98  # ISO/IEC 7810 ID-1, aprox. 1.586

OCR_DIGIT_MAP = str.maketrans({
    "O": "0",
    "Q": "0",
    "D": "0",
    "I": "1",
    "L": "1",
    "Z": "2",
    "S": "5",
    "G": "6",
    "B": "8",
})

OCR_MRZ_MAP = str.maketrans({
    " ": "",
    "«": "<",
    "‹": "<",
    "›": "<",
    "〈": "<",
    "〉": "<",
    "《": "<",
    "》": "<",
    "_": "<",
})


def strip_accents(text: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )


def norm(text: str) -> str:
    text = strip_accents(text or "").upper().strip()
    text = re.sub(r"\s+", " ", text)
    return text


def alnum_compact(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", norm(text))


def json_safe(obj: Any) -> Any:
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(x) for x in obj]
    return obj


def validate_dni(dni: Optional[str]) -> bool:
    if not dni:
        return False
    dni = alnum_compact(dni)
    if not re.fullmatch(r"\d{8}[A-Z]", dni):
        return False
    return DNI_LETTERS[int(dni[:8]) % 23] == dni[-1]


def normalize_dni_candidate(raw: str) -> Optional[str]:
    """
    Intenta corregir confusiones OCR frecuentes SOLO en la parte numérica.
    La letra se conserva como letra; el resultado se acepta aunque no valide,
    para poder generar una advertencia posteriormente.
    """
    s = alnum_compact(raw)
    if len(s) != 9:
        return None

    digits_raw, letter_raw = s[:8], s[8]
    digits = digits_raw.translate(OCR_DIGIT_MAP)
    if not digits.isdigit():
        return None

    if letter_raw.isdigit():
        # Algunas confusiones típicas de OCR en la letra final.
        reverse = {"0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B"}
        letter = reverse.get(letter_raw, letter_raw)
    else:
        letter = letter_raw

    if not re.fullmatch(r"[A-Z]", letter):
        return None
    return digits + letter


def parse_visual_date(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    t = norm(text)
    m = re.search(r"(?<!\d)(\d{1,2})[./\- ](\d{1,2})[./\- ](\d{2,4})(?!\d)", t)
    if not m:
        m = re.search(r"(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)", re.sub(r"\D", "", t))
    if not m:
        return None

    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000 if y <= (date.today().year % 100) + 10 else 1900
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def parse_mrz_date(yymmdd: str, kind: str) -> Optional[str]:
    if not re.fullmatch(r"\d{6}", yymmdd):
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])
    today = date.today()

    if kind == "birth":
        candidates = []
        for century in (1900, 2000):
            try:
                dt = date(century + yy, mm, dd)
            except ValueError:
                continue
            age = (today - dt).days / 365.2425
            if -1 <= age <= 120:
                candidates.append(dt)
        if not candidates:
            return None
        # Para nacimiento elegimos la fecha pasada plausible más reciente.
        return max(candidates).isoformat()

    # Para caducidad, el DNI actual normalmente cae cerca de la fecha presente.
    candidates = []
    for century in (1900, 2000, 2100):
        try:
            dt = date(century + yy, mm, dd)
        except ValueError:
            continue
        delta_years = abs((dt - today).days / 365.2425)
        if delta_years <= 30:
            candidates.append((delta_years, dt))
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1].isoformat()


# =============================================================================
# Geometría / OCR
# =============================================================================

@dataclass
class OCRToken:
    text: str
    score: float
    box: Tuple[float, float, float, float]  # x1, y1, x2, y2

    @property
    def cx(self) -> float:
        return (self.box[0] + self.box[2]) / 2.0

    @property
    def cy(self) -> float:
        return (self.box[1] + self.box[3]) / 2.0

    @property
    def w(self) -> float:
        return max(1.0, self.box[2] - self.box[0])

    @property
    def h(self) -> float:
        return max(1.0, self.box[3] - self.box[1])


@dataclass
class OCRPage:
    tokens: List[OCRToken]
    raw: Dict[str, Any]
    preprocessed_bgr: Optional[np.ndarray] = None


@dataclass
class MRZResult:
    lines: List[str]
    valid: bool
    fields: Dict[str, Any]
    checks: Dict[str, bool]
    errors: List[str]


class DNIReader:
    """
    Prototipo de lectura de DNI español a partir de una foto frontal y otra trasera.

    Flujo:
      1) Corrige EXIF.
      2) Intenta localizar la tarjeta y corregir perspectiva con OpenCV.
      3) PaddleOCR corrige orientación 0/90/180/270 y lee texto.
      4) Extrae campos visuales por regex + etiquetas y proximidad geométrica.
      5) Busca y valida una MRZ TD1 en el reverso.
      6) Fusiona frontal/reverso y genera advertencias.
    """

    FRONT_LABELS = {
        "name": ["NOMBRE", "GIVEN NAME", "GIVEN NAMES", "NOM"],
        "surname": ["APELLIDOS", "SURNAME", "SURNAMES", "COGNOMS"],
        "birth": ["NACIMIENTO", "DATE OF BIRTH", "NAIXEMENT", "NACEMENTO"],
        "expiry": ["VALIDEZ", "EXPIRY", "DATE OF EXPIRY", "VALIDESA"],
        "issue": ["EXPEDICION", "EMISION", "DATE OF ISSUE", "EXPEDICIO"],
        "sex": ["SEXO", "SEX"],
        "nationality": ["NACIONALIDAD", "NATIONALITY", "NACIONALITAT"],
        "support": ["SOPORTE", "NUMERO DE SOPORTE", "NUM SOPORTE", "DOCUMENT NO", "DOCUMENT NUMBER"],
        "can": ["CAN"],
    }

    BACK_LABELS = {
        "address": ["DOMICILIO", "DOMICILI","DOMICII", "DOMICI" ,"ADDRESS", "ADRECA", "ENDEREZO"],
        "city": ["LOCALIDAD", "MUNICIPIO", "CITY", "LOCALITAT"],
        "province": ["PROVINCIA", "PROVINCE", "PROVINCIA / PROVINCE"],
        "birth_place": ["LUGAR DE NACIMIENTO", "PLACE OF BIRTH", "LLOC DE NAIXEMENT"],
        "parents": ["HIJO/A DE", "PADRES", "PARENTS"],
    }

    ALL_LABEL_WORDS = {
        "NOMBRE", "GIVEN", "NAME", "APELLIDOS", "SURNAME", "NACIMIENTO", "BIRTH",
        "VALIDEZ", "EXPIRY", "EXPEDICION", "EMISION", "SEXO", "SEX", "NACIONALIDAD",
        "NATIONALITY", "SOPORTE", "DOCUMENT", "DOMICILIO", "ADDRESS", "LOCALIDAD",
        "MUNICIPIO", "PROVINCIA", "PROVINCE", "LUGAR", "PLACE", "PADRES", "PARENTS",
        "CAN", "COGNOMS", "NOM", "NOME", "VALIDESA", "EMISSIO", "NACIONALITAT",
        "NAIXEMENT", "DOMICILI", "LOCALITAT", "EQUIP", "EQUIPO",
    }

    def __init__(
        self,
        device: str = "cpu",
        engine: Optional[str] = None,
        debug_dir: Optional[str] = None,
        ocr_version: str = "PP-OCRv6",
    ) -> None:
        self.debug_dir = Path(debug_dir) if debug_dir else None
        if self.debug_dir:
            self.debug_dir.mkdir(parents=True, exist_ok=True)
        
        model_dir = Path(__file__).resolve().parent / "models"

        doc_orientation_dir = model_dir / "PP-LCNet_x1_0_doc_ori"
        detection_dir = model_dir / "PP-OCRv6_tiny_det"
        recognition_dir = model_dir / "PP-OCRv6_tiny_rec"
        for ruta in (
            doc_orientation_dir,
            detection_dir,
            recognition_dir,
        ):
            if not ruta.exists():
                raise FileNotFoundError(
                    f"No se encuentra el modelo local: {ruta}"
                )
        
        
        kwargs: Dict[str, Any] = {
            "use_doc_orientation_classify": True,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "text_det_limit_side_len": 832,
            "text_det_limit_type": "max",
            "cpu_threads": 1,

            "device": device,

            "text_rec_score_thresh": 0.15,

            # Modelos locales
            "doc_orientation_classify_model_dir": str(doc_orientation_dir),
            "text_detection_model_dir": str(detection_dir),
            "text_recognition_model_dir": str(recognition_dir),

            # Modelos ligeros
            "text_detection_model_name": "PP-OCRv6_tiny_det",
            "text_recognition_model_name": "PP-OCRv6_tiny_rec",

            "enable_mkldnn": False,
        }
        if engine:
            kwargs["engine"] = engine

        self.ocr = PaddleOCR(**kwargs)

    # -------------------------------------------------------------------------
    # API pública
    # -------------------------------------------------------------------------

    def leer_dni(self, frontal: str, trasera: str) -> Dict[str, Any]:
        import gc

        # ============================================================
        # 1. PROCESAR FRONTAL
        # ============================================================

        front_img = self._load_image(frontal)

        front_rect, front_rectified = self._rectify_card(front_img)

        # Ya no necesitamos la fotografía original
        del front_img
        gc.collect()

        self._save_debug_image(
            "01_front_rectified.jpg",
            front_rect
        )

        front_page = self._ocr_image(front_rect)

        # Ya no necesitamos la imagen rectificada
        del front_rect
        gc.collect()

        self._save_debug_preprocessed(
            "03_front_ocr_preprocessed.jpg",
            front_page
        )

        front_fields = self._extract_front_fields(
            front_page.tokens
        )

        front_lines = self._text_lines(front_page.tokens)

        # Ya hemos extraído todo lo necesario del frontal.
        # La imagen preprocesada tampoco hace falta conservarla.
        front_page.preprocessed_bgr = None

        gc.collect()

        # ============================================================
        # 2. PROCESAR REVERSO
        # ============================================================
        back_img = self._load_image(trasera)

        back_rect, back_rectified = self._rectify_card(
            back_img
        )

        del back_img
        gc.collect()

        back_page = self._ocr_image(
            back_rect
        )

        self._save_debug_image(
            "02_back_rectified.jpg",
            back_rect
        )

        del back_rect
        gc.collect()

        self._save_debug_preprocessed(
            "04_back_ocr_preprocessed.jpg",
            back_page
        )

        back_fields = self._extract_back_fields(
            back_page.tokens
        )

        mrz = self._extract_mrz(
            back_page
        )

        back_lines = self._text_lines(
            back_page.tokens
        )

        back_page.preprocessed_bgr = None

        gc.collect()
        # ============================================================
        # 3. FUSIÓN
        # ============================================================

        result = self._merge(
            front_fields,
            back_fields,
            mrz
        )

        result["procesado"] = {
            "frontal_rectificado": front_rectified,
            "trasera_rectificada": back_rectified,
            "ocr_frontal_lineas": front_lines,
            "ocr_trasera_lineas": back_lines
        }

        if self.debug_dir:
            with open(
                self.debug_dir / "resultado.json",
                "w",
                encoding="utf-8"
            ) as f:
                json.dump(
                    json_safe(result),
                    f,
                    ensure_ascii=False,
                    indent=2
                )

        return result
    
    # -------------------------------------------------------------------------
    # Carga y rectificación
    # -------------------------------------------------------------------------

    @staticmethod
    def _load_image(
        path: str,
        max_side: int = 1800
    ) -> np.ndarray:

        p = Path(path)

        if not p.exists():
            raise FileNotFoundError(
                f"No existe la imagen: {p}"
            )

        with Image.open(p) as im:

            # Corregir orientación EXIF
            im = ImageOps.exif_transpose(im)

            # --------------------------------------------------------
            # Reducir ANTES de convertir a NumPy/OpenCV
            # --------------------------------------------------------

            width, height = im.size

            largest_side = max(width, height)

            if largest_side > max_side:

                scale = max_side / float(largest_side)

                new_width = int(round(width * scale))
                new_height = int(round(height * scale))

                im = im.resize(
                    (new_width, new_height),
                    Image.Resampling.LANCZOS
                )

            # Convertir a RGB solo después de reducir
            im = im.convert("RGB")

            arr = np.asarray(im)

            return cv2.cvtColor(
                arr,
                cv2.COLOR_RGB2BGR
            )


    @staticmethod
    def _order_points(pts: np.ndarray) -> np.ndarray:
        rect = np.zeros((4, 2), dtype="float32")
        s = pts.sum(axis=1)
        diff = np.diff(pts, axis=1).reshape(-1)
        rect[0] = pts[np.argmin(s)]      # top-left
        rect[2] = pts[np.argmax(s)]      # bottom-right
        rect[1] = pts[np.argmin(diff)]   # top-right
        rect[3] = pts[np.argmax(diff)]   # bottom-left
        return rect

    def _rectify_card(self, image: np.ndarray) -> Tuple[np.ndarray, bool]:
        original = image.copy()
        h0, w0 = image.shape[:2]
        scale = min(1.0, 1800.0 / max(h0, w0))
        small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(gray, 60, 180)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:30]
        img_area = small.shape[0] * small.shape[1]

        best_quad: Optional[np.ndarray] = None
        best_score = -1.0

        for c in contours:
            area = cv2.contourArea(c)
            if area < img_area * 0.12:
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue

            pts = approx.reshape(4, 2).astype("float32")
            rect = self._order_points(pts)
            tl, tr, br, bl = rect
            width = max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl))
            height = max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl))
            if width < 1 or height < 1:
                continue
            ratio = max(width, height) / min(width, height)
            ratio_error = abs(ratio - CARD_RATIO)
            if ratio_error > 0.45:
                continue
            score = (area / img_area) - 0.25 * ratio_error
            if score > best_score:
                best_score = score
                best_quad = rect

        if best_quad is None:
            return self._resize_landscape(original), False

        # Volver a coordenadas de la imagen original.
        best_quad /= scale
        tl, tr, br, bl = best_quad
        max_w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
        max_h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
        max_w = max(max_w, 2)
        max_h = max(max_h, 2)

        dst = np.array([
            [0, 0],
            [max_w - 1, 0],
            [max_w - 1, max_h - 1],
            [0, max_h - 1],
        ], dtype="float32")

        matrix = cv2.getPerspectiveTransform(best_quad.astype("float32"), dst)
        warped = cv2.warpPerspective(original, matrix, (max_w, max_h))

        if warped.shape[0] > warped.shape[1]:
            warped = cv2.rotate(warped, cv2.ROTATE_90_CLOCKWISE)

        warped = self._resize_landscape(warped)
        return warped, True

    @staticmethod
    def _resize_landscape(image: np.ndarray, target_width: int = 1400) -> np.ndarray:
        h, w = image.shape[:2]
        if w <= 0 or h <= 0:
            return image
        if h > w:
            image = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
            h, w = image.shape[:2]
        scale = target_width / float(w)
        if 0.85 <= scale <= 1.15:
            return image
        interpolation = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
        return cv2.resize(image, (target_width, int(round(h * scale))), interpolation=interpolation)

    @staticmethod
    def _orient_back_using_mrz(image: np.ndarray) -> Tuple[np.ndarray, bool]:
        """
        Intenta determinar si el reverso del DNI está girado 180 grados
        buscando la zona MRZ.

        La MRZ genera varias líneas horizontales largas y densas.
        Si esas líneas aparecen principalmente en la parte superior,
        se gira la imagen 180 grados.

        Returns:
            imagen corregida,
            True si se ha girado 180 grados.
        """

        if image is None or image.size == 0:
            return image, False

        # ----------------------------------------------------------
        # Trabajar con una copia pequeña para consumir muy poca RAM
        # ----------------------------------------------------------

        h, w = image.shape[:2]

        max_width = 900

        if w > max_width:
            scale = max_width / float(w)

            small = cv2.resize(
                image,
                (
                    max_width,
                    int(round(h * scale))
                ),
                interpolation=cv2.INTER_AREA
            )
        else:
            small = image

        gray = cv2.cvtColor(
            small,
            cv2.COLOR_BGR2GRAY
        )

        h, w = gray.shape


        # ----------------------------------------------------------
        # Blackhat:
        # resalta texto oscuro sobre fondo claro
        # ----------------------------------------------------------

        blackhat_kernel = cv2.getStructuringElement(
            cv2.MORPH_RECT,
            (35, 7)
        )

        blackhat = cv2.morphologyEx(
            gray,
            cv2.MORPH_BLACKHAT,
            blackhat_kernel
        )


        # ----------------------------------------------------------
        # Gradiente horizontal
        # ----------------------------------------------------------

        grad_x = cv2.Sobel(
            blackhat,
            ddepth=cv2.CV_32F,
            dx=1,
            dy=0,
            ksize=-1
        )

        grad_x = np.absolute(grad_x)

        min_val = grad_x.min()
        max_val = grad_x.max()

        if max_val - min_val > 0:

            grad_x = (
                255 *
                ((grad_x - min_val) /
                (max_val - min_val))
            ).astype("uint8")

        else:

            grad_x = np.zeros_like(
                gray,
                dtype="uint8"
            )


        # ----------------------------------------------------------
        # Unir letras de una misma línea
        # ----------------------------------------------------------

        close_kernel = cv2.getStructuringElement(
            cv2.MORPH_RECT,
            (35, 5)
        )

        grad_x = cv2.morphologyEx(
            grad_x,
            cv2.MORPH_CLOSE,
            close_kernel
        )


        # ----------------------------------------------------------
        # Binarización
        # ----------------------------------------------------------

        _, thresh = cv2.threshold(
            grad_x,
            0,
            255,
            cv2.THRESH_BINARY | cv2.THRESH_OTSU
        )


        # ----------------------------------------------------------
        # Buscar bloques horizontales largos
        # ----------------------------------------------------------

        contours, _ = cv2.findContours(
            thresh,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )

        top_score = 0.0
        bottom_score = 0.0

        for contour in contours:

            x, y, bw, bh = cv2.boundingRect(
                contour
            )

            if bh <= 0:
                continue

            aspect_ratio = bw / float(bh)

            # La MRZ genera bloques horizontales bastante largos
            if (
                bw >= w * 0.30
                and aspect_ratio >= 4.0
                and bh <= h * 0.15
            ):

                center_y = y + bh / 2.0

                score = bw * bh

                if center_y < h * 0.45:

                    top_score += score

                elif center_y > h * 0.55:

                    bottom_score += score


        # ----------------------------------------------------------
        # Si la concentración fuerte está arriba,
        # probablemente el DNI está boca abajo
        # ----------------------------------------------------------

        if (
            top_score > 0
            and top_score > bottom_score * 1.15
        ):

            rotated = cv2.rotate(
                image,
                cv2.ROTATE_180
            )

            return rotated, True


        return image, False
    # -------------------------------------------------------------------------
    # OCR
    # -------------------------------------------------------------------------

    def _ocr_image(
        self,
        image: np.ndarray,
        use_doc_orientation_classify: bool = True,
        use_textline_orientation: bool = False,
    ) -> OCRPage:
        results = self.ocr.predict(
            image,
            use_doc_orientation_classify=use_doc_orientation_classify,
            use_doc_unwarping=False,
            use_textline_orientation=use_textline_orientation,
        )
        if not results:
            return OCRPage(tokens=[], raw={}, preprocessed_bgr=None)

        res = results[0]
        payload = getattr(res, "json", {})
        if callable(payload):
            payload = payload()
        payload = payload or {}
        data = payload.get("res", payload)

        texts_raw = data.get("rec_texts", [])
        if isinstance(texts_raw, np.ndarray):
            texts_raw = texts_raw.tolist()
        texts = list(texts_raw) if texts_raw is not None else []

        scores_raw = data.get("rec_scores", [])
        if isinstance(scores_raw, np.ndarray):
            scores_raw = scores_raw.tolist()
        scores = list(scores_raw) if scores_raw is not None else []

        boxes_raw = data.get("rec_boxes", None)
        if boxes_raw is None or len(boxes_raw) == 0:
            boxes_raw = data.get("rec_polys", [])
        if isinstance(boxes_raw, np.ndarray):
            boxes_raw = boxes_raw.tolist()

        tokens: List[OCRToken] = []
        for i, text in enumerate(texts):
            if not str(text).strip():
                continue
            score = float(scores[i]) if i < len(scores) else 0.0
            box = self._to_rect_box(boxes_raw[i]) if i < len(boxes_raw) else (0.0, float(i), 1.0, float(i + 1))
            tokens.append(OCRToken(text=str(text).strip(), score=score, box=box))

        # ------------------------------------------------------------
        # NO conservar datos pesados de Paddle salvo que estemos
        # trabajando expresamente en modo debug.
        # ------------------------------------------------------------

        preprocessed_bgr = None

        if self.debug_dir is not None:

            try:

                img_dict = getattr(
                    res,
                    "img",
                    None
                )

                if callable(img_dict):
                    img_dict = img_dict()

                if isinstance(img_dict, dict):

                    pil_img = img_dict.get(
                        "preprocessed_img"
                    )

                    if pil_img is None:
                        pil_img = img_dict.get(
                            "ocr_res_img"
                        )

                    if pil_img is not None:

                        arr = np.asarray(
                            pil_img.convert("RGB")
                            if hasattr(pil_img, "convert")
                            else pil_img
                        )

                        if (
                            arr.ndim == 3
                            and arr.shape[2] >= 3
                        ):

                            preprocessed_bgr = cv2.cvtColor(
                                arr[:, :, :3],
                                cv2.COLOR_RGB2BGR
                            )

            except Exception:

                preprocessed_bgr = None


        # IMPORTANTE:
        # Antes guardábamos json_safe(data), que copia toda la salida
        # de Paddle a estructuras Python. No la utilizamos.
        return OCRPage(
            tokens=tokens,
            raw={},
            preprocessed_bgr=preprocessed_bgr
        )
    @staticmethod
    def _to_rect_box(box: Any) -> Tuple[float, float, float, float]:
        arr = np.asarray(box, dtype=float)
        if arr.ndim == 1 and arr.size >= 4:
            x1, y1, x2, y2 = arr[:4]
            return float(x1), float(y1), float(x2), float(y2)
        arr = arr.reshape(-1, 2)
        xs, ys = arr[:, 0], arr[:, 1]
        return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())

    @staticmethod
    def _group_lines(tokens: Sequence[OCRToken]) -> List[List[OCRToken]]:
        if not tokens:
            return []
        sorted_tokens = sorted(tokens, key=lambda t: (t.cy, t.cx))
        median_h = float(np.median([t.h for t in sorted_tokens])) if sorted_tokens else 20.0
        y_tol = max(8.0, median_h * 0.65)

        lines: List[List[OCRToken]] = []
        centers: List[float] = []
        for token in sorted_tokens:
            placed = False
            for idx, cy in enumerate(centers):
                if abs(token.cy - cy) <= y_tol:
                    lines[idx].append(token)
                    centers[idx] = float(np.mean([t.cy for t in lines[idx]]))
                    placed = True
                    break
            if not placed:
                lines.append([token])
                centers.append(token.cy)

        ordered = sorted(zip(lines, centers), key=lambda x: x[1])
        return [sorted(line, key=lambda t: t.cx) for line, _ in ordered]

    def _text_lines(self, tokens: Sequence[OCRToken]) -> List[str]:
        return [" ".join(t.text for t in line) for line in self._group_lines(tokens)]

    # -------------------------------------------------------------------------
    # Extracción visual del frontal
    # -------------------------------------------------------------------------

    def _extract_front_fields(self, tokens: Sequence[OCRToken]) -> Dict[str, Any]:
        dni, dni_score = self._find_dni(tokens)
        support = self._find_support_number(tokens)
        can = self._find_can(tokens)

        # Para nombres/apellidos es mucho más robusto seguir el orden de líneas
        # del documento que elegir simplemente el token geométricamente más cercano.
        surname = self._person_after_label(tokens, self.FRONT_LABELS["surname"], max_lines=2)
        name = self._person_after_label(tokens, self.FRONT_LABELS["name"], max_lines=1)

        birth = self._nearest_date_to_label(tokens, self.FRONT_LABELS["birth"])
        issue, expiry = self._extract_issue_expiry_pair(tokens)
        if issue is None:
            issue = self._nearest_date_to_label(tokens, self.FRONT_LABELS["issue"])
        if expiry is None:
            expiry = self._nearest_date_to_label(tokens, self.FRONT_LABELS["expiry"])

        sex = self._value_near_label(
            tokens,
            self.FRONT_LABELS["sex"],
            matcher=lambda s: norm(s) in {"M", "F", "X"},
        )
        nationality = self._value_near_label(
            tokens,
            self.FRONT_LABELS["nationality"],
            matcher=lambda s: bool(re.fullmatch(r"[A-Z]{3}", alnum_compact(s))),
        )
        if nationality:
            nationality = alnum_compact(nationality)[:3]

        return {
            "dni": dni,
            "dni_ocr_score": dni_score,
            "dni_valid": validate_dni(dni),
            "numero_soporte": support,
            "can": can,
            "nombre": self._clean_person_name(name),
            "apellidos": self._clean_person_name(surname),
            "fecha_nacimiento": birth,
            "fecha_validez": expiry,
            "fecha_emision": issue,
            "sexo": norm(sex) if sex else None,
            "nacionalidad": nationality,
        }

    def _find_dni(self, tokens: Sequence[OCRToken]) -> Tuple[Optional[str], float]:
        candidates: List[Tuple[bool, float, str]] = []
        texts = [t.text for t in tokens] + self._text_lines(tokens)

        for idx, text in enumerate(texts):
            compact = re.sub(r"[^A-Z0-9]", "", norm(text))
            # Ventanas de 9 caracteres para tolerar texto pegado al DNI.
            for i in range(0, max(1, len(compact) - 8)):
                chunk = compact[i:i + 9]
                if len(chunk) != 9:
                    continue
                cand = normalize_dni_candidate(chunk)
                if not cand:
                    continue
                score = tokens[idx].score if idx < len(tokens) else 0.5
                candidates.append((validate_dni(cand), score, cand))

        if not candidates:
            return None, 0.0
        candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
        valid, score, dni = candidates[0]
        return dni, float(score)

    def _find_support_number(self, tokens: Sequence[OCRToken]) -> Optional[str]:
        near = self._value_near_label(
            tokens,
            self.FRONT_LABELS["support"],
            matcher=lambda s: bool(re.search(r"[A-Z]{3}\d{6}", alnum_compact(s))),
        )
        if near:
            m = re.search(r"[A-Z]{3}\d{6}", alnum_compact(near))
            if m:
                return m.group(0)

        for t in tokens:
            c = alnum_compact(t.text)
            for m in re.finditer(r"[A-Z]{3}\d{6}", c):
                return m.group(0)
        return None

    def _find_can(self, tokens: Sequence[OCRToken]) -> Optional[str]:
        near = self._value_near_label(
            tokens,
            self.FRONT_LABELS["can"],
            matcher=lambda s: bool(re.fullmatch(r"\d{6}", re.sub(r"\D", "", s))),
        )
        if near:
            digits = re.sub(r"\D", "", near)
            if len(digits) == 6:
                return digits

        # En DNI recientes PaddleOCR puede leer perfectamente el CAN pero perder
        # la etiqueta. Como fallback aceptamos un token aislado de 6 cifras que
        # no tenga aspecto de fecha.
        candidates: List[Tuple[float, str]] = []
        for t in tokens:
            digits = re.sub(r"\D", "", t.text)
            if re.fullmatch(r"\d{6}", digits) and not self._looks_like_compact_date(digits):
                candidates.append((t.score, digits))
        if candidates:
            candidates.sort(reverse=True)
            return candidates[0][1]
        return None

    @staticmethod
    def _looks_like_compact_date(s: str) -> bool:
        if not re.fullmatch(r"\d{6}", s):
            return False
        # ddmmyy
        for day, month, year in ((s[:2], s[2:4], s[4:]), (s[4:], s[2:4], s[:2])):
            try:
                date(2000 + int(year), int(month), int(day))
                return True
            except ValueError:
                pass
        return False

    @staticmethod
    def _dates_in_text(text: str) -> List[str]:
        t = norm(text)
        out: List[str] = []
        pattern = r"(?<!\d)(\d{1,2})[./\- ]+(\d{1,2})[./\- ]+(\d{2,4})(?!\d)"
        for m in re.finditer(pattern, t):
            d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if y < 100:
                y += 2000 if y <= (date.today().year % 100) + 10 else 1900
            try:
                out.append(date(y, mo, d).isoformat())
            except ValueError:
                continue
        return out

    def _extract_issue_expiry_pair(self, tokens: Sequence[OCRToken]) -> Tuple[Optional[str], Optional[str]]:
        lines = self._text_lines(tokens)
        issue_aliases = [norm(a) for a in self.FRONT_LABELS["issue"]]
        expiry_aliases = [norm(a) for a in self.FRONT_LABELS["expiry"]]

        for i, line in enumerate(lines):
            nline = norm(line)
            if any(a in nline for a in issue_aliases) and any(a in nline for a in expiry_aliases):
                # Normalmente ambas fechas aparecen juntas en la línea inmediatamente inferior.
                window = " ".join(lines[i:i + 3])
                dates = self._dates_in_text(window)
                if len(dates) >= 2:
                    return dates[0], dates[1]

        # Fallback: si encontramos cualquier línea con dos fechas, solo la usamos
        # cuando está próxima a las etiquetas de emisión/validez.
        for i, line in enumerate(lines):
            dates = self._dates_in_text(line)
            if len(dates) >= 2:
                context = norm(" ".join(lines[max(0, i - 1):i + 1]))
                if any(a in context for a in issue_aliases + expiry_aliases):
                    return dates[0], dates[1]
        return None, None

    def _person_after_label(
        self,
        tokens: Sequence[OCRToken],
        aliases: Sequence[str],
        max_lines: int = 1,
    ) -> Optional[str]:
        grouped = self._group_lines(tokens)
        aliases_n = [norm(a) for a in aliases]

        for idx, line in enumerate(grouped):
            line_text = " ".join(t.text for t in line)
            nline = norm(line_text)
            # Evita falsos positivos de etiquetas cortas: por ejemplo, "NOM"
            # no debe coincidir dentro de "COGNOMS".
            if not any(
                re.search(r"(?<![A-Z0-9])" + re.escape(a) + r"(?![A-Z0-9])", nline)
                for a in aliases_n
            ):
                continue

            collected: List[str] = []
            for next_line in grouped[idx + 1: idx + 1 + max_lines]:
                txt = " ".join(t.text for t in next_line).strip()
                if not txt:
                    continue
                if self._looks_like_label(txt):
                    break
                if self._dates_in_text(txt):
                    break
                if re.search(r"\d", txt):
                    break
                cleaned = self._clean_person_name(txt)
                if not self._is_plausible_person_name(cleaned):
                    break
                collected.append(cleaned)

            if collected:
                return " ".join(collected)
        return None

    def _is_plausible_person_name(self, text: Optional[str]) -> bool:
        if not text:
            return False
        t = self._clean_person_name(text)
        if not t or len(t.replace(" ", "")) < 2:
            return False
        if self._looks_like_label(t):
            return False
        if re.search(r"\d", t):
            return False
        return True

    def _nearest_date_to_label(self, tokens: Sequence[OCRToken], aliases: Sequence[str]) -> Optional[str]:
        label_tokens = self._find_label_tokens(tokens, aliases)
        date_tokens = [(t, parse_visual_date(t.text)) for t in tokens]
        date_tokens = [(t, d) for t, d in date_tokens if d]
        if not date_tokens:
            # Algunas fechas salen agrupadas por línea.
            for line in self._text_lines(tokens):
                d = parse_visual_date(line)
                if d:
                    return d
            return None
        if not label_tokens:
            return None

        best: Optional[Tuple[float, str]] = None
        for label in label_tokens:
            for token, parsed in date_tokens:
                dist = self._geometric_distance(label, token)
                if token.cy < label.cy - 1.5 * label.h:
                    dist += 500
                if best is None or dist < best[0]:
                    best = (dist, parsed)
        return best[1] if best else None

    # -------------------------------------------------------------------------
    # Extracción visual del reverso
    # -------------------------------------------------------------------------

    def _extract_back_fields(self, tokens: Sequence[OCRToken]) -> Dict[str, Any]:
        address, city_fallback, province_fallback = self._extract_address_city_province(tokens)
        city = self._value_near_label(tokens, self.BACK_LABELS["city"], reject=self._looks_like_label) or city_fallback
        province = self._value_near_label(tokens, self.BACK_LABELS["province"], reject=self._looks_like_label) or province_fallback
        birth_place = self._multiline_after_label(tokens, self.BACK_LABELS["birth_place"], max_lines=2)
        parents = self._extract_parents(tokens)

        return {
            "domicilio": self._clean_free_text(address),
            "localidad": self._clean_free_text(city),
            "provincia": self._clean_free_text(province),
            "lugar_nacimiento": self._clean_free_text(birth_place),
            "padres": self._clean_free_text(parents),
        }

    def _extract_address_city_province(
        self,
        tokens: Sequence[OCRToken]
    ) -> Tuple[Optional[str], Optional[str], Optional[str]]:

        grouped = self._group_lines(tokens)

        address_aliases = [
            "DOMICILIO",
            "DOMICILI",
            "DOMICIL"
            "ADDRESS",
            "ADRECA",
            "ENDEREZO",
        ]

        aliases_norm = [norm(a) for a in address_aliases]

        for idx, line in enumerate(grouped):

            raw = " ".join(t.text for t in line).strip()
            nraw = norm(raw)

            # Comprobar si esta línea contiene la etiqueta DOMICILIO
            if not any(alias in nraw for alias in aliases_norm):
                continue

            # ---------------------------------------------------------
            # 1. Intentar obtener dirección de la misma línea
            # ---------------------------------------------------------

            address = raw

            # Eliminar las etiquetas de domicilio del principio
            address = re.sub(
                r"^\s*(?:DOMICILIO|DOMICILI|DOMICIL|ADDRESS|ADRECA|ENDEREZO)"
                r"(?:\s*/\s*(?:DOMICILIO|DOMICILI|DOMICIL|ADDRESS|ADRECA|ENDEREZO))*"
                r"\s*[:\-]?\s*",
                "",
                address,
                flags=re.IGNORECASE,
            ).strip()

            if not address:
                address = None

            # ---------------------------------------------------------
            # 2. Leer las líneas siguientes
            # ---------------------------------------------------------

            following = []

            for next_line in grouped[idx + 1: idx + 6]:

                txt = " ".join(t.text for t in next_line).strip()

                if not txt:
                    continue

                ntxt = norm(txt)

                # Parar cuando empiezan otras secciones del DNI
                if (
                    self._looks_like_mrz(txt)
                    or ntxt == "DNI"
                    or "LUGAR DE NACIMIENTO" in ntxt
                    or "LLOC DE NAIXEMENT" in ntxt
                    or "HIJO/A DE" in ntxt
                    or "FILL/A DE" in ntxt
                    or "EQUIPO" in ntxt
                    or "EQUIP" in ntxt
                ):
                    break

                following.append(txt)

            # ---------------------------------------------------------
            # 3. Si la dirección no estaba junto a DOMICILIO,
            #    la primera línea posterior es la dirección.
            # ---------------------------------------------------------

            if address is None and following:
                address = following.pop(0)

            # ---------------------------------------------------------
            # 4. Siguientes líneas:
            #       localidad
            #       provincia
            # ---------------------------------------------------------

            city = following[0] if len(following) >= 1 else None
            province = following[1] if len(following) >= 2 else None

            return address, city, province

        return None, None, None
    def _extract_parents(self, tokens: Sequence[OCRToken]) -> Optional[str]:
        parents = self._multiline_after_label(tokens, self.BACK_LABELS["parents"], max_lines=1)
        if parents:
            return parents

        # Fallback para OCR degradado de "HIJO/A DE" (p.ej. "HI E DE").
        grouped = self._group_lines(tokens)
        for idx, line in enumerate(grouped[:-1]):
            txt = norm(" ".join(t.text for t in line))
            if len(txt) <= 20 and "HI" in txt and "DE" in txt:
                candidate = " ".join(t.text for t in grouped[idx + 1]).strip()
                if candidate and not self._looks_like_mrz(candidate):
                    return candidate
        return None

    # -------------------------------------------------------------------------
    # Extracción MRZ TD1
    # -------------------------------------------------------------------------

    def _extract_mrz(self, back_page: OCRPage) -> MRZResult:

        candidates = self._mrz_lines_from_tokens(
            back_page.tokens
        )

        parsed = self._try_parse_mrz_candidates(
            candidates
        )

        return parsed
        
    def _back_ocr_is_upside_down(
        self,
        tokens: Sequence[OCRToken]
    ) -> bool:
        """
        Detecta si el reverso del DNI se ha procesado boca abajo (180º)
        observando el orden del texto MRZ reconocido.

        En orientación correcta, 'IDESP' debe aparecer antes que los
        separadores << de la tercera línea (apellidos/nombres).

        Si aparecen << antes de IDESP, normalmente significa que el OCR
        ha recorrido la MRZ desde la tercera línea hacia la primera,
        es decir, el documento está a 180º.
        """

        if not tokens:
            return False

        # Mantener el orden en que PaddleOCR ha devuelto los bloques
        raw_text = " ".join(
            token.text
            for token in tokens
            if token.text
        )

        mrz_text = self._sanitize_mrz(raw_text)

        pos_idesp = mrz_text.find("IDESP")
        pos_double_separator = mrz_text.find("<<")

        if pos_idesp == -1:
            return False

        if pos_double_separator == -1:
            return False

        # Ejemplo boca abajo:
        #
        # BLOM<DAHL<RAMOS<<CARLOS...
        # ...
        # IDESP...
        #
        # Aquí << aparece antes que IDESP.
        return pos_double_separator < pos_idesp    
    
    @staticmethod
    def _enhance_mrz_crop(crop: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        gray = cv2.resize(gray, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    def _mrz_lines_from_tokens(self, tokens: Sequence[OCRToken]) -> List[str]:
        lines = self._group_lines(tokens)
        out: List[str] = []
        max_y = max((max(t.cy for t in line) for line in lines), default=1.0)

        for line in lines:
            raw = "".join(t.text for t in line)
            s = self._sanitize_mrz(raw)
            if len(s) < 18:
                continue

            mean_y = float(np.mean([t.cy for t in line]))
            is_bottom = mean_y >= 0.55 * max_y
            has_mrz_markers = "<" in s or "ESP" in s or s.startswith(("ID", "IA", "IC"))
            if has_mrz_markers or (is_bottom and len(s) >= 22):
                out.append(s)
        return out

    @staticmethod
    def _sanitize_mrz(text: str) -> str:
        s = strip_accents(text).upper().translate(OCR_MRZ_MAP)
        s = re.sub(r"[^A-Z0-9<]", "", s)
        return s

    @staticmethod
    def _mrz_likeness(s: str) -> float:
        if not s:
            return 0.0
        allowed = sum(ch.isalnum() or ch == "<" for ch in s) / len(s)
        bonus = 0.10 if "<" in s else 0.0
        bonus += 0.10 if "ESP" in s or s.startswith(("I", "A", "C")) else 0.0
        return min(1.0, allowed + bonus)

    def _try_parse_mrz_candidates(self, lines: Sequence[str]) -> MRZResult:
        if len(lines) < 3:
            return MRZResult(lines=list(lines), valid=False, fields={}, checks={}, errors=["No se han detectado 3 líneas MRZ TD1."])

        best: Optional[MRZResult] = None
        # Prioriza ternas consecutivas y, si hay ruido, todas las combinaciones cercanas.
        for i in range(len(lines) - 2):
            trio = lines[i:i + 3]
            fitted = self._fit_td1_lines(trio)
            result = self._parse_td1(fitted)
            if best is None or sum(result.checks.values()) > sum(best.checks.values()):
                best = result
            if result.valid:
                return result

        return best or MRZResult(lines=list(lines), valid=False, fields={}, checks={}, errors=["MRZ no interpretable."])

    def _fit_td1_lines(self, trio: Sequence[str]) -> List[str]:
        l1, l2, l3 = [self._sanitize_mrz(x) for x in trio]

        # Línea 1: intenta empezar por I/A/C y, para España, por IDESP si aparece.
        pos = l1.find("IDESP")
        if pos >= 0:
            l1 = l1[pos:]
        elif len(l1) > 30:
            for i, ch in enumerate(l1):
                if ch in "IAC" and len(l1) - i >= 30:
                    l1 = l1[i:]
                    break

        l1 = self._fit_line_30(l1, preserve_last=False)
        l2 = self._fit_line_30(l2, preserve_last=True)
        l3 = self._fit_line_30(l3, preserve_last=False)
        return [l1, l2, l3]

    @staticmethod
    def _fit_line_30(line: str, preserve_last: bool) -> str:
        if len(line) == 30:
            return line
        if len(line) > 30:
            return line[:30]
        missing = 30 - len(line)
        if preserve_last and line and line[-1].isdigit():
            return line[:-1] + ("<" * missing) + line[-1]
        return line + ("<" * missing)

    @staticmethod
    def _mrz_char_value(ch: str) -> int:
        if ch == "<":
            return 0
        if "0" <= ch <= "9":
            return ord(ch) - ord("0")
        if "A" <= ch <= "Z":
            return ord(ch) - ord("A") + 10
        raise ValueError(f"Carácter MRZ no válido: {ch!r}")

    @classmethod
    def _mrz_check_digit(cls, data: str) -> str:
        weights = (7, 3, 1)
        total = sum(cls._mrz_char_value(ch) * weights[i % 3] for i, ch in enumerate(data))
        return str(total % 10)

    @classmethod
    def _check_mrz_field(cls, data: str, digit: str) -> bool:
        return digit.isdigit() and cls._mrz_check_digit(data) == digit

    def _parse_td1(self, lines: Sequence[str]) -> MRZResult:
        errors: List[str] = []
        if len(lines) != 3 or any(len(x) != 30 for x in lines):
            return MRZResult(lines=list(lines), valid=False, fields={}, checks={}, errors=["TD1 requiere 3 líneas de 30 caracteres."])

        l1, l2, l3 = lines
        doc_number = l1[5:14]
        doc_number_cd = l1[14]
        birth = l2[0:6]
        birth_cd = l2[6]
        sex = l2[7]
        expiry = l2[8:14]
        expiry_cd = l2[14]
        nationality = l2[15:18]
        composite_cd = l2[29]

        checks = {
            "document_number": self._check_mrz_field(doc_number, doc_number_cd),
            "birth_date": self._check_mrz_field(birth, birth_cd),
            "expiry_date": self._check_mrz_field(expiry, expiry_cd),
        }

        composite_data = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]
        checks["composite"] = self._check_mrz_field(composite_data, composite_cd)

        surname_part, sep, given_part = l3.partition("<<")
        surnames = " ".join(x for x in surname_part.split("<") if x)
        given_names = " ".join(x for x in given_part.split("<") if x) if sep else None

        optional_combined = l1[15:30] + l2[18:29]
        dni_mrz = self._find_valid_dni_in_text(optional_combined)
        # Algunos diseños podrían usar el número de documento para el DNI.
        if dni_mrz is None:
            doc_candidate = normalize_dni_candidate(doc_number)
            if doc_candidate and validate_dni(doc_candidate):
                dni_mrz = doc_candidate

        fields = {
            "document_type": l1[0:2].replace("<", "") or None,
            "issuer": l1[2:5].replace("<", "") or None,
            "document_number": doc_number.replace("<", "") or None,
            "document_number_check": doc_number_cd,
            "optional_data_1": l1[15:30].replace("<", "") or None,
            "birth_date_raw": birth,
            "birth_date": parse_mrz_date(birth, "birth"),
            "sex": None if sex == "<" else sex,
            "expiry_date_raw": expiry,
            "expiry_date": parse_mrz_date(expiry, "expiry"),
            "nationality": nationality.replace("<", "") or None,
            "optional_data_2": l2[18:29].replace("<", "") or None,
            "surnames": surnames or None,
            "given_names": given_names,
            "dni_candidate": dni_mrz,
        }

        if not checks["document_number"]:
            errors.append("Falla el dígito de control del número de documento MRZ.")
        if not checks["birth_date"]:
            errors.append("Falla el dígito de control de la fecha de nacimiento MRZ.")
        if not checks["expiry_date"]:
            errors.append("Falla el dígito de control de la fecha de caducidad MRZ.")
        if not checks["composite"]:
            errors.append("Falla el dígito de control compuesto de la MRZ.")

        # Consideramos válida la MRZ solo si pasa todas las comprobaciones básicas.
        valid = all(checks.values())
        return MRZResult(lines=list(lines), valid=valid, fields=fields, checks=checks, errors=errors)

    @staticmethod
    def _find_valid_dni_in_text(text: str) -> Optional[str]:
        s = alnum_compact(text)
        for i in range(max(0, len(s) - 8)):
            cand = normalize_dni_candidate(s[i:i + 9])
            if cand and validate_dni(cand):
                return cand
        return None

    # -------------------------------------------------------------------------
    # Reglas geométricas / etiquetas
    # -------------------------------------------------------------------------

    def _find_label_tokens(self, tokens: Sequence[OCRToken], aliases: Sequence[str]) -> List[OCRToken]:
        aliases_n = [norm(a) for a in aliases]
        found: List[OCRToken] = []
        for token in tokens:
            t = norm(token.text)
            if any(a in t for a in aliases_n):
                found.append(token)
        return found

    @staticmethod
    def _geometric_distance(a: OCRToken, b: OCRToken) -> float:
        dx = max(0.0, b.box[0] - a.box[2]) if b.cx >= a.cx else abs(b.cx - a.cx) * 1.5
        dy = abs(b.cy - a.cy)
        # Mismo renglón: preferencia fuerte a la derecha.
        if dy <= max(a.h, b.h) * 0.9 and b.cx >= a.cx:
            return dx + dy * 1.5
        # Debajo: también plausible.
        if b.cy >= a.cy:
            return dy * 2.0 + abs(b.cx - a.cx) * 0.35
        return 1000.0 + dy * 3.0 + abs(b.cx - a.cx)

    def _value_near_label(
        self,
        tokens: Sequence[OCRToken],
        aliases: Sequence[str],
        matcher=None,
        reject=None,
    ) -> Optional[str]:
        labels = self._find_label_tokens(tokens, aliases)
        if not labels:
            return None

        aliases_n = [norm(a) for a in aliases]
        # 1) Intentar extraer valor pegado en el mismo bloque OCR.
        for label in labels:
            txt = norm(label.text)
            for alias in aliases_n:
                pos = txt.find(alias)
                if pos >= 0:
                    rest = txt[pos + len(alias):].strip(" /:-")
                    if rest and (matcher is None or matcher(rest)) and (reject is None or not reject(rest)):
                        return rest

        # 2) Buscar bloque geométricamente próximo.
        best: Optional[Tuple[float, OCRToken]] = None
        for label in labels:
            for token in tokens:
                if token is label:
                    continue
                if token.score < 0.12:
                    continue
                candidate = token.text.strip()
                if reject and reject(candidate):
                    continue
                if matcher and not matcher(candidate):
                    continue
                dist = self._geometric_distance(label, token)
                if dist > 700:
                    continue
                if best is None or dist < best[0]:
                    best = (dist, token)
        return best[1].text if best else None

    def _multiline_after_label(
        self,
        tokens: Sequence[OCRToken],
        aliases: Sequence[str],
        max_lines: int = 2,
    ) -> Optional[str]:
        grouped = self._group_lines(tokens)
        aliases_n = [norm(a) for a in aliases]
        stop_aliases = [
            "LUGAR DE NACIMIENTO", "PLACE OF BIRTH", "PADRES", "PARENTS", "DOMICILIO", "ADDRESS",
            "LOCALIDAD", "MUNICIPIO", "PROVINCIA", "PROVINCE",
        ]

        for idx, line in enumerate(grouped):
            line_text = " ".join(t.text for t in line)
            nline = norm(line_text)
            matched_alias = next((a for a in aliases_n if a in nline), None)
            if not matched_alias:
                continue

            collected: List[str] = []
            rest = nline.split(matched_alias, 1)[1].strip(" /:-")
            if rest and not self._looks_like_mrz(rest):
                collected.append(rest)

            for next_line in grouped[idx + 1: idx + 1 + max_lines]:
                txt = " ".join(t.text for t in next_line).strip()
                ntxt = norm(txt)
                if self._looks_like_mrz(ntxt):
                    break
                if any(alias in ntxt for alias in stop_aliases if alias not in aliases_n):
                    break
                if txt:
                    collected.append(txt)

            return " ".join(collected).strip() or None
        return None

    def _looks_like_label(self, text: str) -> bool:
        words = set(norm(text).replace("/", " ").replace(":", " ").split())
        return bool(words & self.ALL_LABEL_WORDS)

    @staticmethod
    def _looks_like_mrz(text: str) -> bool:
        s = DNIReader._sanitize_mrz(text)
        return len(s) >= 18 and ("<" in s or s.startswith("IDESP"))

    @staticmethod
    def _clean_person_name(text: Optional[str]) -> Optional[str]:
        if not text:
            return None
        t = norm(text)
        t = re.sub(r"[^A-ZÀ-ÖØ-ÝÑÇ'\- ]", " ", t)
        t = re.sub(r"\s+", " ", t).strip(" -/")
        return t or None

    @staticmethod
    def _clean_free_text(text: Optional[str]) -> Optional[str]:
        if not text:
            return None
        t = re.sub(r"\s+", " ", text).strip(" -/")
        return t or None

    # -------------------------------------------------------------------------
    # Fusión y validaciones
    # -------------------------------------------------------------------------

    def _merge(self, front: Dict[str, Any], back: Dict[str, Any], mrz: MRZResult) -> Dict[str, Any]:
        m = mrz.fields if mrz.fields else {}
        warnings: List[str] = list(mrz.errors)

        dni_front = front.get("dni")
        dni_mrz = m.get("dni_candidate")
        dni_final = dni_front if validate_dni(dni_front) else dni_mrz

        if dni_front and not validate_dni(dni_front):
            warnings.append(f"El DNI leído en el frontal ({dni_front}) no supera la validación de letra.")
        if dni_front and dni_mrz and dni_front != dni_mrz:
            warnings.append(f"DNI frontal ({dni_front}) y candidato MRZ ({dni_mrz}) no coinciden.")

        birth_front = front.get("fecha_nacimiento")
        birth_mrz = m.get("birth_date")
        if birth_front and birth_mrz and birth_front != birth_mrz:
            warnings.append(f"Fecha de nacimiento frontal ({birth_front}) y MRZ ({birth_mrz}) no coinciden.")

        expiry_front = front.get("fecha_validez")
        expiry_mrz = m.get("expiry_date")
        if expiry_front and expiry_mrz and expiry_front != expiry_mrz:
            warnings.append(f"Fecha de validez frontal ({expiry_front}) y MRZ ({expiry_mrz}) no coinciden.")

        sex_front = front.get("sexo")
        sex_mrz = m.get("sex")
        if sex_front and sex_mrz and norm(sex_front) != norm(sex_mrz):
            warnings.append(f"Sexo frontal ({sex_front}) y MRZ ({sex_mrz}) no coinciden.")

        nat_front = front.get("nacionalidad")
        nat_mrz = m.get("nationality")
        if nat_front and nat_mrz and norm(nat_front) != norm(nat_mrz):
            warnings.append(f"Nacionalidad frontal ({nat_front}) y MRZ ({nat_mrz}) no coinciden.")

        support = front.get("numero_soporte")
        mrz_doc_number = m.get("document_number")
        if not support and mrz_doc_number and re.fullmatch(r"[A-Z]{3}\d{6}", mrz_doc_number):
            support = mrz_doc_number

        result = {
            "documento": {
                "tipo": "DNI",
                "numero": dni_final,
                "numero_soporte": support,
                "can": front.get("can"),
            },
            "titular": {
                "nombre": (
                    front.get("nombre")
                    if self._is_plausible_person_name(front.get("nombre"))
                    else m.get("given_names")
                ),
                "apellidos": (
                    front.get("apellidos")
                    if self._is_plausible_person_name(front.get("apellidos"))
                    else m.get("surnames")
                ),
                "sexo": front.get("sexo") or m.get("sex"),
                "nacionalidad": front.get("nacionalidad") or m.get("nationality"),
                "fecha_nacimiento": birth_front or birth_mrz,
                "lugar_nacimiento": back.get("lugar_nacimiento"),
                "padres": back.get("padres"),
            },
            "fechas": {
                "emision": front.get("fecha_emision"),
                "validez": expiry_front or expiry_mrz,
            },
            "domicilio": {
                "direccion": back.get("domicilio"),
                "localidad": back.get("localidad"),
                "provincia": back.get("provincia"),
            },
            "mrz": {
                "detectada": len(mrz.lines) == 3,
                "valida": mrz.valid,
                "lineas": mrz.lines,
                "campos": m,
                "checks": mrz.checks,
            },
            "validacion": {
                "dni_valido": validate_dni(dni_final),
                "mrz_valida": mrz.valid,
                "requiere_revision": False,
                "advertencias": warnings,
            },
            "fuentes": {
                "frontal": front,
                "trasera": back,
            },
        }

        # Criterio conservador: si falta DNI, el DNI no valida, la MRZ no valida,
        # o existen discrepancias relevantes, se marca para revisión.
        critical_missing = dni_final is None or not validate_dni(dni_final)
        result["validacion"]["requiere_revision"] = bool(critical_missing or not mrz.valid or warnings)

        return result

    # -------------------------------------------------------------------------
    # Debug
    # -------------------------------------------------------------------------

    def _save_debug_image(self, filename: str, image: np.ndarray) -> None:
        if self.debug_dir is None or image is None or image.size == 0:
            return
        cv2.imwrite(str(self.debug_dir / filename), image)

    def _save_debug_preprocessed(self, filename: str, page: OCRPage) -> None:
        if page.preprocessed_bgr is not None:
            self._save_debug_image(filename, page.preprocessed_bgr)


# =============================================================================
# CLI
# =============================================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prototipo OCR de DNI español: frontal + trasera")
    parser.add_argument("--front", required=True, help="Ruta a la foto frontal")
    parser.add_argument("--back", required=True, help="Ruta a la foto trasera")
    parser.add_argument("--out", default="resultado_dni.json", help="JSON de salida")
    parser.add_argument("--debug-dir", default="debug_dni", help="Carpeta de depuración")
    parser.add_argument("--device", default="cpu", help="PaddleOCR: cpu, gpu:0, etc.")
    parser.add_argument("--engine", default=None, help="Opcional: paddle_static, paddle_dynamic, onnxruntime...")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    reader = DNIReader(device=args.device, engine=args.engine, debug_dir=args.debug_dir)
    result = reader.leer_dni(args.front, args.back)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(json_safe(result), f, ensure_ascii=False, indent=2)

    print(json.dumps(json_safe(result), ensure_ascii=False, indent=2))
    print(f"\nResultado guardado en: {out.resolve()}")


if __name__ == "__main__":
    main()
