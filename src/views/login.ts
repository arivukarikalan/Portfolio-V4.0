import { APP_NAME, APPS_SCRIPT_URL } from '../core/constants';
import { clearSession, getSession, setSession } from '../storage/db';
import { loginWithSheet, requestUserAccess } from '../services/auth';
import { clearAlert, setBusy, showAlert } from '../ui/feedback';
import { lucideIcon, initLucide } from '../ui/icons';
import { toErrorMessage } from '../utils/errors';
import type { UserSession } from '../core/types';

function normalizeUsername(value: string): string {
  return String(value || '').trim();
}

function normalizePassword(value: string): string {
  return String(value || '').trim();
}

function isValidPassword(value: string): boolean {
  return /^(?=.*[A-Za-z])(?=.*\d).{6,}$/.test(value);
}

function landingPageFor(session: UserSession): string {
  return session.role === 'ADMIN' ? 'admin.html' : 'dashboard.html';
}

function redirectToLanding(session: UserSession): void {
  window.location.href = landingPageFor(session);
}

function setFieldError(target: HTMLElement, message: string): void {
  if (!message) {
    target.textContent = '';
    target.classList.add('d-none');
    return;
  }
  target.textContent = message;
  target.classList.remove('d-none');
}

function attachPasswordToggle(input: HTMLInputElement, button: HTMLButtonElement): void {
  const updateIcon = (visible: boolean) => {
    button.innerHTML = lucideIcon(visible ? 'eye-off' : 'eye');
    initLucide();
  };

  updateIcon(false);
  button.addEventListener('click', () => {
    const isVisible = input.type === 'text';
    input.type = isVisible ? 'password' : 'text';
    updateIcon(!isVisible);
  });
}

export function renderLoginView(root: HTMLElement): void {
  root.innerHTML = `
    <div class="min-vh-100 d-flex align-items-center bg-light py-5">
      <div class="container">
        <div class="row justify-content-center">
          <div class="col-12 col-sm-10 col-md-7 col-lg-5">
            <div class="text-center mb-4">
              <h1 class="h3 mb-1">${APP_NAME}</h1>
              <div class="text-muted small">Admin-approved access</div>
            </div>
            <div class="card shadow-sm border-0">
              <div class="card-body p-4">
                <div id="auth-feedback" class="alert d-none" role="alert"></div>
                <div id="session-panel" class="d-none">
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                      <div class="fw-semibold">You are already signed in.</div>
                      <div class="text-muted small" id="session-name"></div>
                    </div>
                    <span class="badge text-bg-primary text-uppercase" id="session-role"></span>
                  </div>
                  <div class="d-flex gap-2">
                    <button class="btn btn-primary flex-fill" id="continue-btn" type="button">Continue</button>
                    <button class="btn btn-outline-secondary" id="logout-btn" type="button">Logout</button>
                  </div>
                  <hr class="my-4" />
                </div>
                <div id="auth-tabs" class="mb-4">
                  <div class="btn-group w-100" role="tablist">
                    <button class="btn btn-primary active" id="tab-signin" type="button">Sign In</button>
                    <button class="btn btn-outline-success" id="tab-signup" type="button">Sign Up</button>
                  </div>
                </div>
                <div id="signin-panel">
                  <form id="login-form" class="vstack gap-3" autocomplete="on">
                    <div>
                      <label class="form-label" for="login-username">Username</label>
                      <input class="form-control" id="login-username" type="text" autocomplete="username" required />
                    </div>
                    <div>
                      <label class="form-label" for="login-password">Password</label>
                      <div class="input-group">
                        <input class="form-control" id="login-password" type="password" autocomplete="current-password" required />
                        <button class="btn btn-outline-secondary" type="button" id="toggle-login-password" aria-label="Toggle password visibility">
                          ${lucideIcon('eye')}
                        </button>
                      </div>
                    </div>
                    <button class="btn btn-primary w-100" type="submit" id="login-btn">Sign In</button>
                  </form>
                </div>
                <div id="signup-panel" class="d-none">
                  <form id="register-form" class="vstack gap-3" autocomplete="off">
                    <div class="small text-muted">
                      Your request goes to the admin for approval.
                    </div>
                    <div>
                      <label class="form-label" for="register-username">Username</label>
                      <input class="form-control" id="register-username" type="text" autocomplete="username" required />
                    </div>
                    <div>
                      <label class="form-label" for="register-password">Password</label>
                      <div class="input-group">
                        <input class="form-control" id="register-password" type="password" autocomplete="new-password" required />
                        <button class="btn btn-outline-secondary" type="button" id="toggle-register-password" aria-label="Toggle password visibility">
                          ${lucideIcon('eye')}
                        </button>
                      </div>
                      <div class="form-text text-danger d-none" id="register-password-error"></div>
                    </div>
                    <div>
                      <label class="form-label" for="register-confirm">Confirm Password</label>
                      <div class="input-group">
                        <input class="form-control" id="register-confirm" type="password" autocomplete="new-password" required />
                        <button class="btn btn-outline-secondary" type="button" id="toggle-register-confirm" aria-label="Toggle password visibility">
                          ${lucideIcon('eye')}
                        </button>
                      </div>
                      <div class="form-text text-danger d-none" id="register-confirm-error"></div>
                    </div>
                    <button class="btn btn-success" type="submit" id="register-btn">Request Access</button>
                  </form>
                </div>
              </div>
            </div>
            <div class="text-center text-muted small mt-3">
              Cloud sync uses a private Apps Script URL. Keep it secure.
            </div>
            <div class="text-center text-muted small mt-1">
              © 2026 Arivu
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  initLucide();

  const feedback = root.querySelector<HTMLDivElement>('#auth-feedback');
  const sessionPanel = root.querySelector<HTMLDivElement>('#session-panel');
  const sessionName = root.querySelector<HTMLDivElement>('#session-name');
  const sessionRole = root.querySelector<HTMLSpanElement>('#session-role');
  const continueBtn = root.querySelector<HTMLButtonElement>('#continue-btn');
  const logoutBtn = root.querySelector<HTMLButtonElement>('#logout-btn');
  const authTabs = root.querySelector<HTMLDivElement>('#auth-tabs');
  const tabSignin = root.querySelector<HTMLButtonElement>('#tab-signin');
  const tabSignup = root.querySelector<HTMLButtonElement>('#tab-signup');
  const signinPanel = root.querySelector<HTMLDivElement>('#signin-panel');
  const signupPanel = root.querySelector<HTMLDivElement>('#signup-panel');
  const loginForm = root.querySelector<HTMLFormElement>('#login-form');
  const loginBtn = root.querySelector<HTMLButtonElement>('#login-btn');
  const loginUser = root.querySelector<HTMLInputElement>('#login-username');
  const loginPass = root.querySelector<HTMLInputElement>('#login-password');
  const loginToggle = root.querySelector<HTMLButtonElement>('#toggle-login-password');
  const registerForm = root.querySelector<HTMLFormElement>('#register-form');
  const registerBtn = root.querySelector<HTMLButtonElement>('#register-btn');
  const registerUser = root.querySelector<HTMLInputElement>('#register-username');
  const registerPass = root.querySelector<HTMLInputElement>('#register-password');
  const registerConfirm = root.querySelector<HTMLInputElement>('#register-confirm');
  const registerToggle = root.querySelector<HTMLButtonElement>('#toggle-register-password');
  const registerConfirmToggle = root.querySelector<HTMLButtonElement>('#toggle-register-confirm');
  const registerPassError = root.querySelector<HTMLDivElement>('#register-password-error');
  const registerConfirmError = root.querySelector<HTMLDivElement>('#register-confirm-error');

  if (
    !feedback ||
    !sessionPanel ||
    !sessionName ||
    !sessionRole ||
    !continueBtn ||
    !logoutBtn ||
    !authTabs ||
    !tabSignin ||
    !tabSignup ||
    !signinPanel ||
    !signupPanel ||
    !loginForm ||
    !loginBtn ||
    !loginUser ||
    !loginPass ||
    !loginToggle ||
    !registerForm ||
    !registerBtn ||
    !registerUser ||
    !registerPass ||
    !registerConfirm ||
    !registerToggle ||
    !registerConfirmToggle ||
    !registerPassError ||
    !registerConfirmError
  ) {
    throw new Error('Login view failed to initialize');
  }

  attachPasswordToggle(loginPass, loginToggle);
  attachPasswordToggle(registerPass, registerToggle);
  attachPasswordToggle(registerConfirm, registerConfirmToggle);

  const toggleTabs = (target: 'signin' | 'signup') => {
    const signinActive = target === 'signin';
    tabSignin.classList.toggle('active', signinActive);
    tabSignin.classList.toggle('btn-primary', signinActive);
    tabSignin.classList.toggle('btn-outline-primary', !signinActive);

    tabSignup.classList.toggle('active', !signinActive);
    tabSignup.classList.toggle('btn-success', !signinActive);
    tabSignup.classList.toggle('btn-outline-success', signinActive);

    signinPanel.classList.toggle('d-none', !signinActive);
    signupPanel.classList.toggle('d-none', signinActive);
  };

  const setFormsDisabled = (disabled: boolean) => {
    [
      loginUser,
      loginPass,
      loginBtn,
      registerUser,
      registerPass,
      registerConfirm,
      registerBtn,
      tabSignin,
      tabSignup
    ].forEach((el) => {
      el.disabled = disabled;
    });
  };

  if (!APPS_SCRIPT_URL) {
    showAlert(feedback, 'warning', 'Apps Script URL is missing. Set VITE_APPS_SCRIPT_URL and reload.');
    setFormsDisabled(true);
  }

  tabSignin.addEventListener('click', () => toggleTabs('signin'));
  tabSignup.addEventListener('click', () => toggleTabs('signup'));

  let currentSession: UserSession | null = null;
  continueBtn.addEventListener('click', () => {
    if (currentSession) redirectToLanding(currentSession);
  });

  logoutBtn.addEventListener('click', async () => {
    await clearSession();
    currentSession = null;
    sessionPanel.classList.add('d-none');
    authTabs.classList.remove('d-none');
    signinPanel.classList.remove('d-none');
    toggleTabs('signin');
    showAlert(feedback, 'info', 'Logged out. Please sign in again.');
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!APPS_SCRIPT_URL) return;
    clearAlert(feedback);

    const username = normalizeUsername(loginUser.value);
    const password = normalizePassword(loginPass.value);

    if (!username || !password) {
      showAlert(feedback, 'danger', 'Username and password are required.');
      return;
    }

    setBusy(loginBtn, true, 'Sign In');
    try {
      const session = await loginWithSheet(username, password);
      await setSession(session);
      currentSession = session;
      showAlert(feedback, 'success', 'Login successful. Redirecting...');
      redirectToLanding(session);
    } catch (error) {
      showAlert(feedback, 'danger', toErrorMessage(error));
    } finally {
      setBusy(loginBtn, false, 'Sign In');
    }
  });

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!APPS_SCRIPT_URL) return;
    clearAlert(feedback);
    setFieldError(registerPassError, '');
    setFieldError(registerConfirmError, '');

    const username = normalizeUsername(registerUser.value);
    const password = normalizePassword(registerPass.value);
    const confirm = normalizePassword(registerConfirm.value);

    if (!username || !password || !confirm) {
      showAlert(feedback, 'danger', 'All fields are required.');
      return;
    }

    if (!isValidPassword(password)) {
      setFieldError(
        registerPassError,
        'Password must be at least 6 characters and include a letter and a number.'
      );
      return;
    }

    if (password !== confirm) {
      setFieldError(registerConfirmError, 'Passwords do not match.');
      return;
    }

    setBusy(registerBtn, true, 'Request Access');
    try {
      const message = await requestUserAccess({ username, password });
      showAlert(feedback, 'success', message);
      registerForm.reset();
      toggleTabs('signin');
    } catch (error) {
      showAlert(feedback, 'danger', toErrorMessage(error));
    } finally {
      setBusy(registerBtn, false, 'Request Access');
    }
  });

  void (async () => {
    const session = await getSession();
    if (!session) return;
    currentSession = session;
    sessionName.textContent = `${session.name} (${session.userId})`;
    sessionRole.textContent = session.role;
    sessionPanel.classList.remove('d-none');
    authTabs.classList.add('d-none');
    signinPanel.classList.add('d-none');
    signupPanel.classList.add('d-none');
  })();
}
