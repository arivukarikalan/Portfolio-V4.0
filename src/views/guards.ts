import { getSession } from '../storage/db';
import { applyUiSettings, loadUiSettings } from '../ui/preferences';
import type { UserRole, UserSession } from '../core/types';

export async function requireSession(role?: UserRole): Promise<UserSession | null> {
  const session = await getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  applyUiSettings(loadUiSettings(session.userId));
  if (role && session.role !== role) {
    window.location.href = 'dashboard.html';
    return null;
  }
  return session;
}
