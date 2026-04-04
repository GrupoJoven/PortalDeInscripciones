
import React, { useEffect, useState } from 'react';
import { Church, Lock, Mail, ArrowRight } from 'lucide-react';

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
}

const REMEMBER_EMAIL_KEY = 'remembered_login_email';

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [rememberUser, setRememberUser] = useState(false);
  const [password, setPassword] = useState('');

  // Cargar email recordado al montar
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_EMAIL_KEY);
      if (saved) {
        setEmail(saved);
        setRememberUser(true);
      }
    } catch {
      // Si localStorage está bloqueado (algunos navegadores/modos), no hacemos nada
    }
  }, []);

  const persistEmailIfNeeded = (nextRemember: boolean, nextEmail: string) => {
    try {
      const clean = nextEmail.trim();
      if (nextRemember && clean) {
        localStorage.setItem(REMEMBER_EMAIL_KEY, clean);
      } else {
        localStorage.removeItem(REMEMBER_EMAIL_KEY);
      }
    } catch {
      // localStorage no disponible: ignoramos
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      alert("Por favor introduce tu correo y contraseña");
      return;
    }

    // Guardar/borrar email según checkbox (antes o después da igual)
    persistEmailIfNeeded(rememberUser, email);

    setIsLoading(true);
    try {
      await onLogin(email, password);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl shadow-slate-200 overflow-hidden">
        <div className="p-10 bg-indigo-700 text-white flex flex-col items-center gap-4">
          <div className="w-20 h-20 bg-white/20 rounded-3xl flex items-center justify-center backdrop-blur-md shadow-inner">
            <Church size={40} />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">Grupo Joven</h1>
            <p className="text-indigo-100 text-xs font-bold uppercase tracking-widest mt-1">
              Gestión de Inscripciones
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1 ml-1">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="email"
                  placeholder="ej: coordinador@parroquia.es"
                  value={email}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEmail(v);
                    // Si está marcado, mantenemos actualizado lo guardado
                    if (rememberUser) persistEmailIfNeeded(true, v);
                  }}
                  autoComplete="email"
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1 ml-1">
                Contraseña
              </label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
              </div>
            </div>

            {/* Checkbox "Recordar email" */}
            <label className="flex items-center gap-3 pt-1 select-none">
              <input
                type="checkbox"
                checked={rememberUser}
                onChange={(e) => {
                  const next = e.target.checked;
                  setRememberUser(next);
                  persistEmailIfNeeded(next, email);
                }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-700 focus:ring-indigo-500"
              />
              <span className="text-sm text-slate-600">Recordar email</span>
            </label>
          </div>

          <div className="pt-6 flex items-center justify-center">
            <img
              src="https://pqycvrpdyebshkfaxzmi.supabase.co/storage/v1/object/public/public_media/logo-limpio-normal-1-removebg-preview.png"
              alt="Logo San Pascual Baylón"
              className="max-h-32 w-auto object-contain drop-shadow-sm"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-indigo-700 hover:bg-indigo-800 text-white font-bold py-4 rounded-2xl transition-all flex items-center justify-center gap-2 group shadow-xl shadow-indigo-100"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
            ) : (
              <>
                Entrar al Panel
                <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;

