import { useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from './document';

type CheckState = { status: 'idle' | 'loading' | 'success' | 'error'; message: string };

function IdentityCheck({ provider, native }: { provider: 'github' | 'jira'; native: boolean }) {
  const [result, setResult] = useState<CheckState>({ status: 'idle', message: '' });
  const jira = provider === 'jira';
  const title = jira ? 'Jira Cloud' : 'GitHub';

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const token = String(data.get('token') ?? '');
    data.delete('token');
    (form.elements.namedItem('token') as HTMLInputElement).value = '';
    setResult({ status: 'loading', message: 'Checking identity and secure credential storage…' });
    try {
      const identity = await invoke<{ account: string }>(jira ? 'check_jira' : 'check_github', jira
        ? { site: String(data.get('site')), email: String(data.get('email')), token }
        : { token });
      setResult({ status: 'success', message: `Verified ${identity.account}. Token stored in the OS credential store.` });
    } catch (error) {
      const message = errorMessage(error);
      setResult({ status: 'error', message: token ? message.split(token).join('[redacted]') : message });
    }
  }

  return <form className="connection-form" onSubmit={check} autoComplete="off">
    <h2>{title}</h2>
    <p>{jira ? 'Read your account through Jira Cloud REST API v3. Use a personal API token only if your organization permits it.' : 'Read your account through the GitHub REST API. Use a personal access token authorized for your account.'}</p>
    <fieldset disabled={!native || result.status === 'loading'}>
      <legend className="visually-hidden">{title} credentials</legend>
      {jira ? <>
        <label htmlFor="jira-site">Jira Cloud site</label>
        <input id="jira-site" name="site" type="text" placeholder="your-team.atlassian.net" required spellCheck={false} autoCapitalize="none" />
        <label htmlFor="jira-email">Account email</label>
        <input id="jira-email" name="email" type="email" required autoCapitalize="none" />
      </> : null}
      <label htmlFor={`${provider}-token`}>{jira ? 'API token' : 'Personal access token'}</label>
      <input id={`${provider}-token`} name="token" type="password" required autoComplete="off" spellCheck={false} autoCapitalize="none" aria-describedby={`${provider}-token-help`} />
      <p className="field-help" id={`${provider}-token-help`}>Cleared from this form when submitted. Never saved in browser storage or the Vault.</p>
      <button className="primary" type="submit">{result.status === 'loading' ? 'Checking…' : `Check ${title} identity`}</button>
    </fieldset>
    {result.status !== 'idle' ? <p className={`connection-result ${result.status}`} role={result.status === 'error' ? 'alert' : 'status'}>{result.message}</p> : null}
  </form>;
}

export default function Connections({ native }: { native: boolean }) {
  return <section className="connections" aria-labelledby="connections-heading">
    <header className="section-heading"><h1 id="connections-heading">Connection checks</h1><p>Real, read-only identity requests. A check succeeds only after secure credential storage succeeds.</p></header>
    <div className="connection-note">M0 checks account access only. Repositories, work items, synchronization, and Vault-scoped connections are not implemented yet.</div>
    <div className="connection-columns"><IdentityCheck provider="github" native={native} /><IdentityCheck provider="jira" native={native} /></div>
  </section>;
}
