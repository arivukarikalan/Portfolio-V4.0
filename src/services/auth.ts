import type { UserRole, UserSession } from '../core/types';
import { postApi } from './api';

type LoginData = {
  user: {
    userId: string;
    name: string;
    email?: string;
    role: UserRole;
    adminSessionToken?: string;
  };
};

export async function loginWithSheet(loginId: string, password: string): Promise<UserSession> {
  const data = await postApi<LoginData>({
    mode: 'login',
    loginId: loginId.trim(),
    password
  });

  return {
    userId: data.user.userId,
    name: data.user.name,
    email: data.user.email ?? '',
    role: data.user.role,
    adminSessionToken: data.user.adminSessionToken,
    createdAt: new Date().toISOString()
  };
}

export async function requestUserAccess(input: {
  username: string;
  password: string;
}): Promise<string> {
  const name = input.username.trim();
  const loginId = input.username.trim().toLowerCase();

  const data = await postApi<{ requestId: string; message: string }>({
    mode: 'register_user',
    name,
    loginId,
    password: input.password,
    email: ''
  });

  return data.message || `Request submitted: ${data.requestId}`;
}
