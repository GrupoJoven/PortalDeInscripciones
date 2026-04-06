import React, { useState, useEffect } from 'react';
import { 
  BrowserRouter as Router, 
  Routes, 
  Route, 
  Navigate, 
  Link
} from 'react-router-dom';

import type { Session, User } from '@supabase/supabase-js';
import { ErrorBoundary } from './components/ErrorBoundary';
import Login from './components/Login';
import AdminPanel from './components/AdminPanel';
import HomePage from './components/HomePage';
import VerifyParentEmailPage from './components/VerifyParentEmailPage';
import VerifyPublicFormEmailPage from './components/VerifyPublicFormEmailPage';

import AppLayout from './layout/AppLayout';

import { 
  LogOut,
  ShieldCheck,
  Settings,
  Plus,
  Trash2,
  Power,
  PowerOff,
  XCircle,
  Search,
  RefreshCcw,
  Copy,
  KeyRound,
  Users,
} from 'lucide-react';


import { supabase } from './lib/supabaseClient';

// --- Main App ---

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [isCoordinator, setIsCoordinator] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  
  useEffect(() => {
    let mounted = true;

    const loadSession = async () => {
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error('Error obteniendo sesión:', error);
        if (mounted) {
          setAuthLoading(false);
        }
        return;
      }

      if (!mounted) return;

      setSession(data.session ?? null);
      setAuthUser(data.session?.user ?? null);
    };

    loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session ?? null);
      setAuthUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const checkCoordinator = async () => {
      if (!authUser?.id) {
        setIsCoordinator(false);
        setAuthLoading(false);
        return;
      }

      setAuthLoading(true);

      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', authUser.id)
        .maybeSingle();

      if (error) {
        console.error('Error comprobando rol:', error);
        setIsCoordinator(false);
        setAuthLoading(false);
        return;
      }

      setIsCoordinator(data?.role === 'coordinator');
      setAuthLoading(false);
    };

    checkCoordinator();
  }, [authUser]);

  
  const handleLogin = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw new Error(error.message);
    }
  };

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('Error al cerrar sesión:', error);
    }
  };

  return (
    <ErrorBoundary>
      <Router>
        <AppLayout user={authUser} onLogout={handleLogout}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/verify-parent-email" element={<VerifyParentEmailPage />} />
            <Route path="/verify-public-form-email" element={<VerifyPublicFormEmailPage />} />
            <Route
              path="/admin"
              element={
                <AdminPanel
                  user={authUser}
                  isCoordinator={isCoordinator}
                  authLoading={authLoading}
                  onLogin={handleLogin}
                  onLogout={handleLogout}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </AppLayout>
      </Router>
    </ErrorBoundary>
  );
}
