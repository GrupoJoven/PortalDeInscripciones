import type { User } from '@supabase/supabase-js';
import { ShieldCheck } from 'lucide-react';
import NavigationBar from './NavigationBar';

interface Props {
  user: User | null;
  onLogout: () => void;
  children: React.ReactNode;
}

export default function AppLayout({ user, onLogout, children }: Props) {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <NavigationBar user={user} onLogout={onLogout} />

      <main>{children}</main>

      <footer className="py-12 px-6 border-t border-slate-200 mt-20">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 opacity-50">
            <ShieldCheck className="w-5 h-5" />
            <span className="font-bold text-sm">
              Portal de Control de Acceso
            </span>
          </div>
          <p className="text-slate-400 text-sm">
            © {new Date().getFullYear()} — Gestión de Inscripciones Segura
          </p>
        </div>
      </footer>
    </div>
  );
}