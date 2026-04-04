import { Link } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';
import { LogOut, Lock } from 'lucide-react';

interface Props {
  user: User | null;
  onLogout: () => void;
}

export default function NavigationBar({ user, onLogout }: Props) {
  return (
    <nav className="bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center sticky top-0 z-50">
      <Link to="/" className="flex items-center gap-2 group">
        <div className="flex items-center gap-3">
          <img
            src="https://pqycvrpdyebshkfaxzmi.supabase.co/storage/v1/object/public/public_media/logo-limpio-normal-1.png"
            alt="Logo San Pascual Baylón"
            className="h-14 w-auto object-contain"
          />

          <span className="text-lg font-bold text-slate-900">
            Portal de Inscripciones
          </span>
        </div>
      </Link>

      <div className="flex items-center gap-4">
        {user ? (
          <>
            <Link
              to="/admin"
              className="text-slate-600 hover:text-indigo-600 font-medium transition-colors"
            >
              Panel Admin
            </Link>

            <button
              onClick={onLogout}
              className="text-slate-500 hover:text-red-600 transition-colors flex items-center gap-1.5"
            >
              <LogOut className="w-4 h-4" />
              Salir
            </button>
          </>
        ) : (
          <Link
            to="/admin"
            className="bg-slate-100 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-200 transition-colors font-medium flex items-center gap-2"
          >
            <Lock className="w-4 h-4" />
            Admin
          </Link>
        )}
      </div>
    </nav>
  );
}