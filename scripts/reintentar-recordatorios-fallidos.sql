-- Reintenta el envío de "recordar identificadores" SOLO para los 136
-- destinatarios que fallaron en el envío masivo del 2026-09-01 (identificados
-- a partir del log de la función: todos fallaron por RateLimitError).
--
-- Antes de ejecutar esto:
--
--   1) Desplegar la versión corregida de las funciones (ya no encadenan una
--      llamada HTTP interna entre sí, que era la causa real de los fallos):
--
--        supabase functions deploy send-form-policy-email --project-ref pqycvrpdyebshkfaxzmi
--        supabase functions deploy send-public-id-reminders --project-ref pqycvrpdyebshkfaxzmi
--
--   2) Crear el secreto de disparo manual (mismo patrón que ya usáis para
--      DNI_CLEANUP_SECRET en dni-verification-cleanup):
--
--        supabase secrets set REMINDERS_MANUAL_TRIGGER_SECRET=<inventa-un-valor-largo-y-aleatorio> --project-ref pqycvrpdyebshkfaxzmi
--
--      y sustituir 'TU_SECRETO_AQUI' más abajo por ese mismo valor.
--
--   3) Tener la extensión pg_net habilitada (ya lo estará si seguiste la guía
--      de docs/VERIFICACION-DNI.md para la limpieza de sesiones DNI).

create extension if not exists pg_net;

-- 2026-09-01: primera pasada -> sent: 106, failed: 0, next_offset: 106.
-- No hace falta reenviar a los 106 que ya lo recibieron: el offset de abajo
-- hace que esta llamada continúe justo con los 30 que faltan.
select net.http_post(
  url := 'https://pqycvrpdyebshkfaxzmi.supabase.co/functions/v1/send-public-id-reminders',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-manual-trigger-secret', 'TU_SECRETO_AQUI'
  ),
  body := jsonb_build_object(
    'offset', 106,
    'emails', array[
        'bpvfarma@gmail.com'
        ,'btguardiola@gmail.com'
        ,'butrillas@gmail.com'
        ,'bvidorreta@gmail.com'
        ,'canito.cmc@gmail.com'
        ,'caparicimonton@gmail.com'
        ,'carferbon@yahoo.es'
        ,'carmen.royo@royogroup.com'
        ,'carmenferrer77@hotmail.com'
        ,'carminamaiques@hotmail.com'
        ,'carolinasarrion@outlook.com'
        ,'casadelosmilio@hotmail.com'
        ,'celia.castro.arnau@gmail.com'
        ,'cervera.maria@hotmail.com'
        ,'chimovh@yahoo.es'
        ,'clcartecontemporaneo@gmail.com'
        ,'cmontoro@metrolevante.com'
        ,'cmonzo@raizde3.com'
        ,'constanza643@icpv.com'
        ,'conta@regneiuris.com'
        ,'correlimo@hotmail.com'
        ,'covaencanada@yahoo.es'
        ,'crisbgarrigues@gmail.com'
        ,'crisgubla@hotmail.com'
        ,'cristina.a.dacosta@gmail.com'
        ,'cristinacanetlaguarda@hotmail.com'
        ,'cristinachapa@hotmail.com'
        ,'cristinamarcovila@gmail.com'
        ,'cristinavelezsendra@gmail.com'
        ,'cristiniky@hotmail.com'
        ,'daniellaadame@hotmail.com'
        ,'david.benede@aam.com'
        ,'didio_28@yahoo.com'
        ,'dra_isa@hotmail.com'
        ,'drops.arq@gmail.com'
        ,'e.beltran@scesclavas.com'
        ,'eduapca@gmail.com'
        ,'ehervas@sonab.es'
        ,'elena@kaosa.com'
        ,'elena@villarealcf.es'
        ,'elenacasadogarrido@hotmail.com'
        ,'elenaplanellsg@gmail.com'
        ,'elenaravello@hotmail.com'
        ,'elsavguiza@hotmail.com'
        ,'elviraselva@hotmail.com'
        ,'eseifra37@hotmail.com'
        ,'evalia776@hotmail.com'
        ,'familia.rosillo.esquembre@gmail.com'
        ,'familiachacopino@gmail.com'
        ,'franciscoguillem@abogadosaip.es'
        ,'franivars24@gmail.com'
        ,'geguzba@gmail.com'
        ,'geniborso@hotmail.com'
        ,'gerardocodes@yahoo.es'
        ,'gonniamoros@gmail.com'
        ,'greigpalmero@gmail.com'
        ,'hroig@edem.es'
        ,'idoiaselva@hotmail.com'
        ,'info@clcartecontemporaneo.com'
        ,'inma.zarranz@gmail.com'
        ,'inmavera2@gmail.com'
        ,'insanlazaro@hotmail.com'
        ,'ipenades@yahoo.es'
        ,'isa_roca_serra@yahoo.es'
        ,'isabeldomenechnavarro@gmail.com'
        ,'isabelgilgomez@yahoo.com'
        ,'isabelrinyoncorts@hotmail.com'
        ,'ita_vila@hotmail.com'
        ,'mariagaro78@gmail.com'
        ,'mariajedur@gmail.com'
        ,'mariamunozruiz@gmail.com'
        ,'marian.villarroel@icloud.com'
        ,'mariloromera@gmail.com'
        ,'marsanpa21@hotmail.com'
        ,'marta-espuny@hotmail.com'
        ,'marta.escolanoderivas@gmail.com'
        ,'martaalino2@gmail.com'
        ,'martabover@icav.es'
        ,'martacalatayud@hotmail.com'
        ,'martasinis@hotmail.com'
        ,'mgarciamart@icloud.com'
        ,'mgisbertrueda@hotmail.com'
        ,'mgvilella@yahoo.es'
        ,'mhmascaros.937@gmail.com'
        ,'mialisiete@gmail.com'
        ,'mlasaramos@hotmail.com'
        ,'moenpu@yahoo.es'
        ,'monica_romar@hotmail.com'
        ,'monicaballestersolaz@gmail.com'
        ,'montanejos3@gmail.com'
        ,'msaes10@hotmail.com'
        ,'msalgadod@cualtis.com'
        ,'mtramoyeres@hotmail.com'
        ,'mutrillas@hotmail.com'
        ,'myrimarespi@gmail.com'
        ,'nachofelipo@gmail.com'
        ,'naiaralz@hotmail.com'
        ,'nalajo@gmail.com'
        ,'nandosaldial@gmail.com'
        ,'nataliafosguillen@yahoo.es'
        ,'natasancht@gmail.com'
        ,'nnavarroalamar@hotmail.com'
        ,'ocosin2@gmail.com'
        ,'olguita225@hotmail.com'
        ,'p_benedito@indas.es'
        ,'pabloycarmela@yahoo.es'
        ,'palmenarllorens@gmail.com'
        ,'palocarbo@gmail.com'
        ,'palomabuj@yahoo.es'
        ,'palomadelportillo@gmail.com'
        ,'palomavilar@hotmail.com'
        ,'paskysegura@gmail.com'
        ,'paticb@telefonica.net'
        ,'patriciamarcovila@gmail.com'
        ,'paulaselva@yahoo.es'
        ,'pazbellot@gmail.com'
        ,'pbonet@ice.upv.es'
        ,'pedro-depedro@hotmail.com'
        ,'pedrosangil@hotmail.com'
        ,'pilarvazquezm@hotmail.com'
        ,'pilukamarin23@hotmail.com'
        ,'pinaes@gmail.com'
        ,'ptortosaroyo@gmail.com'
        ,'pvignes@valvulasarco.com'
        ,'reyestrenor@gmail.com'
        ,'rferrerharo@gmail.com'
        ,'rgarcia@cesce.es'
        ,'roci_o@hotmail.com'
        ,'roig@errearquitectura.com'
        ,'rollosal@gmail.com'
        ,'rosabordils@hotmail.com'
        ,'sally@salomejoyas.com'
        ,'salome1111@hotmail.es'
        ,'sandrina347@gmail.com'
        ,'saramll@hotmail.com'
        ,'silviagil@icav.es'
    ]
  )
) as request_id;

-- Con 136 destinatarios a 2 en paralelo cada 800ms, puede que no dé tiempo a
-- todos dentro del límite de 50s de la función (quedaría "next_offset" sin
-- procesar). Comprueba el resultado en el dashboard:
--   https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/logs/edge-functions
-- Busca la línea "send-public-id-reminders result:" más reciente.
--
-- Si "next_offset" no es null, NO repitas el bloque tal cual (reenviaría a
-- quien ya lo recibió): actualiza el valor de 'offset' de arriba al que te
-- devuelva "next_offset" y vuelve a ejecutar. Si "failed" es mayor que 0,
-- esos destinatarios concretos sí puedes reintentarlos con el offset actual
-- (aún no se procesaron con éxito), sin esperar ningún minuto extra.
