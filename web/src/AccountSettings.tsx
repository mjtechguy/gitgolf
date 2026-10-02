import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { History, KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import type { User } from './gen/golf/v1/golf_pb';

export function AccountLayout({ children }: { children: ReactNode }) {
  return <div className="account-layout"><nav className="account-navigation" aria-label="Account settings"><span className="eyebrow">PERSONAL SETTINGS</span>
    <Link to="/account/settings" activeOptions={{ exact:true }}><UserRound size={18} />Profile</Link>
    <Link to="/account/sessions" activeOptions={{ exact:true }}><ShieldCheck size={18} />Sessions</Link>
    <Link to="/account/ssh-keys" activeOptions={{ exact:true }}><KeyRound size={18} />SSH keys</Link>
    <Link to="/account/api-credentials" activeOptions={{ exact:true }}><KeyRound size={18} />API credentials</Link>
    <Link to="/audit" activeOptions={{ exact:true }}><History size={18} />Account activity</Link>
  </nav><div className="account-content">{children}</div></div>;
}

export function AccountSettings({ user }: { user: User }) {
  return <section aria-labelledby="settings-title">
    <header className="repository-intro"><div><span className="eyebrow">YOUR GOLF ACCOUNT</span><h1 id="settings-title"><UserRound size={29} />Profile</h1><p>Your identity, access and account preferences.</p></div></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="profile-title"><div className="browser-panel-heading"><h2 id="profile-title">Account profile</h2><span className="visibility">View only</span></div>
      <div className="credential-form-content"><dl className="settings-profile"><div><dt>Username</dt><dd>{user.login}</dd></div><div><dt>Display name</dt><dd>{user.fullName || 'Not set'}</dd></div><div><dt>Instance role</dt><dd>{user.isInstanceAdmin ? 'Instance administrator' : 'Personal workspace'}</dd></div></dl>
        <p className="field-help">Profile edits, email changes and password recovery currently require your administrator. Self-service account editing is still being built.</p>
      </div>
    </section>
    <section className="browser-panel credential-list-panel" aria-labelledby="account-access-title"><div className="browser-panel-heading"><h2 id="account-access-title">Access and security</h2></div><div className="credential-form-content">
      <p>Review your active browser sessions, manage Git SSH keys, and issue read-only API credentials for your tools. Account activity records successful session changes.</p>
      <div className="credential-actions"><Link className="button secondary" to="/account/sessions"><ShieldCheck size={17} />Manage sessions</Link><Link className="button secondary" to="/account/ssh-keys"><KeyRound size={17} />Manage SSH keys</Link></div>
      <p className="field-help">Multi-factor authentication, connected identity providers, notification preferences and scoped agent credentials are planned. They are not configurable yet.</p>
    </div></section>
    <section className="browser-panel credential-list-panel" aria-labelledby="appearance-title"><div className="browser-panel-heading"><h2 id="appearance-title">Appearance</h2></div><div className="credential-form-content"><p>Use the sun or moon button in the header to switch between dark and light. Your choice is remembered in this browser.</p></div></section>
  </section>;
}
