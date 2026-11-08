import { CheckCircle2, KeyRound, ShieldCheck, WifiOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { publicCall, useAuth } from './api';
import { Button, Field, Logo } from './ui';

export function Login({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (setupRequired && password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      const s = setupRequired
        ? await publicCall('auth.setup', { username, displayName: displayName || username, password })
        : await publicCall('auth.login', { username, password });
      signIn({ token: s.token, admin: s.admin });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <Logo size={52} />
          <div>
            <div className="brand-name">PULSE</div>
            <div className="brand-sub">Attendance Intelligence</div>
          </div>
        </div>
        <div>
          <h2>Attendance you can trust, entirely on your own network.</h2>
          <p>Phones prove who they are with device-bound cryptographic keys. Every record is saved to this computer before anyone is told it worked.</p>
          <div className="pts" style={{ marginTop: 28 }}>
            <div><ShieldCheck size={18} /> Admin-approved devices, signed scans, replay-proof codes</div>
            <div><WifiOff size={18} /> Works offline — no cloud, no database, no accounts</div>
            <div><CheckCircle2 size={18} /> Tamper-evident event log and one-click Excel exports</div>
          </div>
        </div>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <div>
            <h1>{setupRequired ? 'Create the owner account' : 'Administrator sign-in'}</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              {setupRequired ? 'First-time setup. This account can manage everything, including other administrators.' : 'Sign in to manage attendance, devices and exports.'}
            </p>
          </div>
          {error ? <div className="err" role="alert">{error}</div> : null}
          <Field label="Username">
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" name="username" />
          </Field>
          {setupRequired ? (
            <Field label="Your name">
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} name="displayName" />
            </Field>
          ) : null}
          <Field label="Password" hint={setupRequired ? 'At least 12 characters with upper- and lower-case letters and a digit.' : undefined}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} name="password" />
          </Field>
          {setupRequired ? (
            <Field label="Confirm password">
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" name="confirm" />
            </Field>
          ) : null}
          <Button variant="primary" block loading={busy} type="submit">
            <KeyRound size={16} /> {setupRequired ? 'Create account & continue' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
