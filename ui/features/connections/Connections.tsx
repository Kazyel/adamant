import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import type { Connection } from '../work-context/types';

type CheckState = { status: 'idle' | 'loading' | 'success' | 'error'; message: string };

function IdentityCheck({
  provider,
  native,
  onConnected,
}: {
  provider: 'github' | 'jira';
  native: boolean;
  onConnected: () => void;
}) {
  const [result, setResult] = useState<CheckState>({ status: 'idle', message: '' });
  const jira = provider === 'jira';
  const title = jira ? 'Jira Cloud' : 'GitHub';

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const tokenValue = data.get('token');
    const token = typeof tokenValue === 'string' ? tokenValue : '';
    const site = data.get('site');
    const email = data.get('email');
    data.delete('token');
    (form.elements.namedItem('token') as HTMLInputElement).value = '';
    setResult({ status: 'loading', message: 'Checking identity and secure credential storage…' });
    try {
      const identity = await invoke<{ account: string }>(
        jira ? 'check_jira' : 'check_github',
        jira
          ? {
              site: typeof site === 'string' ? site : '',
              email: typeof email === 'string' ? email : '',
              token,
            }
          : { token },
      );
      setResult({
        status: 'success',
        message: `Verified ${identity.account}. Token stored in the OS credential store.`,
      });
      onConnected();
    } catch (error) {
      const message = errorMessage(error);
      setResult({
        status: 'error',
        message: token ? message.split(token).join('[redacted]') : message,
      });
    }
  }

  return (
    <form className="connection-form" onSubmit={(event) => void check(event)} autoComplete="off">
      <h2>{title}</h2>
      <p>
        {jira
          ? 'Connect Jira Cloud with your account email and an API token permitted by your organization.'
          : 'Connect GitHub with a personal access token restricted to the repositories and permissions you need.'}
      </p>
      <fieldset disabled={!native || result.status === 'loading'}>
        <legend className="visually-hidden">{title} credentials</legend>
        {jira ? (
          <>
            <label htmlFor="jira-site">Jira Cloud site</label>
            <input
              id="jira-site"
              name="site"
              type="text"
              placeholder="your-team.atlassian.net"
              required
              spellCheck={false}
              autoCapitalize="none"
            />
            <label htmlFor="jira-email">Account email</label>
            <input id="jira-email" name="email" type="email" required autoCapitalize="none" />
          </>
        ) : null}
        <label htmlFor={`${provider}-token`}>{jira ? 'API token' : 'Personal access token'}</label>
        <input
          id={`${provider}-token`}
          name="token"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          aria-describedby={`${provider}-token-help`}
        />
        <p className="field-help" id={`${provider}-token-help`}>
          Cleared from this form when submitted. Never saved in browser storage or the Vault.{' '}
          Reading and writing require the corresponding provider permissions. Connecting does not
          modify remote items.
        </p>
        <button className="primary" type="submit">
          {result.status === 'loading' ? 'Connecting…' : `Connect ${title}`}
        </button>
      </fieldset>
      {result.status !== 'idle' ? (
        <p
          className={`connection-result ${result.status}`}
          role={result.status === 'error' ? 'alert' : 'status'}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}

export default function Connections({ native }: { native: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!native) {
      return;
    }
    let current = true;
    void invoke<Connection[]>('work_connections').then(
      (result) => {
        if (current) {
          setConnections(result);
          setError('');
        }
      },
      (reason: unknown) => {
        if (current) {
          setError(errorMessage(reason));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [native, revision]);

  return (
    <section className="connections" aria-labelledby="connections-heading">
      <header className="section-heading">
        <h1 id="connections-heading">Connections</h1>
        <p>
          Connect accounts here, then choose repositories and Jira projects in your project
          workspace. Tokens stay in the OS credential store.
        </p>
      </header>
      {!native ? (
        <p className="connection-note">
          Open the desktop application to connect accounts securely.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {connections.length ? (
        <section className="connected-accounts" aria-labelledby="connected-accounts-heading">
          <h2 id="connected-accounts-heading">Connected accounts</h2>
          <ul>
            {connections.map((connection) => (
              <li key={connection.id}>
                <strong>{connection.account}</strong>
                <span>
                  {connection.provider === 'github' ? 'GitHub' : 'Jira Cloud'} · {connection.host}
                </span>
              </li>
            ))}
          </ul>
          <p className="field-help">
            Reconnect the same account below to replace an expired token. Saved context remains
            available offline.
          </p>
        </section>
      ) : null}
      <div className="connection-columns">
        <IdentityCheck
          provider="github"
          native={native}
          onConnected={() => setRevision((value) => value + 1)}
        />
        <IdentityCheck
          provider="jira"
          native={native}
          onConnected={() => setRevision((value) => value + 1)}
        />
      </div>
    </section>
  );
}
