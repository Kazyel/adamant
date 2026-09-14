import Form from '../../shared/ui/Form';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import ProviderIcon from '../work-context/ProviderIcon';
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
    if (!native || result.status === 'loading') {
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    const tokenValue = data.get('token');
    const token = typeof tokenValue === 'string' ? tokenValue : '';
    const site = data.get('site');
    const email = data.get('email');
    data.delete('token');
    const tokenInput = form.elements.namedItem('token');
    if (tokenInput instanceof HTMLInputElement) {
      tokenInput.value = '';
    }
    setResult({
      status: 'loading',
      message: 'Verifying your account and saving the token securely…',
    });
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
        message: `Connected as ${identity.account}. Open a workspace and choose Workspace actions → Manage sources to add work.`,
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
    <Form className="connection-form" onSubmit={(event) => void check(event)} autoComplete="off">
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
          The token clears when submitted and stays in your system’s secure credential store.{' '}
          Reading and writing require the corresponding provider permissions. Connecting does not
          modify remote items.
        </p>
        <button className="primary" type="submit">
          {result.status === 'loading' ? (
            <span className="loading-indicator" aria-hidden="true" />
          ) : (
            <WorkspaceIcon name="link" />
          )}
          {result.status === 'loading' ? 'Connecting…' : `Connect ${title}`}
        </button>
      </fieldset>
      {result.status !== 'idle' ? (
        <p
          className={`connection-result ${result.status}`}
          role={result.status === 'error' ? 'alert' : 'status'}
        >
          {result.message}
          {result.status === 'error' ? (
            <span className="connection-retry-help">
              Check your details and permissions, then paste the token again to retry.
            </span>
          ) : null}
        </p>
      ) : null}
    </Form>
  );
}

const services = {
  github: {
    title: 'GitHub',
    description: 'Issues, pull requests and the conversations behind your code.',
    help: 'Use a personal access token restricted to the repositories and permissions you need.',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
  jira: {
    title: 'Jira Cloud',
    description: 'Project issues, priorities and the details that keep work moving.',
    help: 'Use your Jira Cloud site, account email and an API token allowed by your organization.',
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
};

function ServiceConnection({
  provider,
  accounts,
  native,
  onConnected,
}: {
  provider: Connection['provider'];
  accounts: Connection[];
  native: boolean;
  onConnected: () => void;
}) {
  const service = services[provider];
  const [linkError, setLinkError] = useState('');

  async function openTokenPage() {
    setLinkError('');
    try {
      await invoke('open_link', { url: service.tokenUrl });
    } catch (error) {
      setLinkError(errorMessage(error));
    }
  }

  return (
    <section
      className={`connection-service connection-service-${provider}`}
      aria-labelledby={`${provider}-heading`}
    >
      <header className="connection-service-heading">
        <span className="connection-brand">
          <ProviderIcon provider={provider} />
        </span>
        <div>
          <h2 id={`${provider}-heading`}>{service.title}</h2>
          <p>{service.description}</p>
        </div>
      </header>
      {accounts.length > 0 ? (
        <ul className="connection-accounts" aria-label={`${service.title} saved accounts`}>
          {accounts.map((account) => (
            <li key={account.id}>
              <WorkspaceIcon name="check" />
              <div>
                <strong>{account.account}</strong>
                <span>{account.host}</span>
              </div>
              <span className="connection-saved">Account saved</span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="connection-setup">
        <summary>
          <WorkspaceIcon name={accounts.length ? 'settings' : 'plus'} />
          <span>
            {accounts.length ? 'Add account or replace token' : `Connect ${service.title}`}
          </span>
        </summary>
        <div className="connection-setup-content">
          <div className="connection-guide">
            <h3>{accounts.length ? 'Keep your account connected' : 'Start with your account'}</h3>
            <p>{service.help}</p>
            {accounts.length ? (
              <p>
                To replace an expired token, connect the same account again. Your saved work stays
                available offline.
              </p>
            ) : null}
            <button type="button" disabled={!native} onClick={() => void openTokenPage()}>
              Create a token <WorkspaceIcon name="external" />
            </button>
            {linkError ? (
              <p className="connection-error" role="alert">
                {linkError}
              </p>
            ) : null}
          </div>
          <IdentityCheck provider={provider} native={native} onConnected={onConnected} />
        </div>
      </details>
    </section>
  );
}

export default function Connections({
  native,
  onWorkspace,
}: {
  native: boolean;
  onWorkspace: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(native);

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
          setLoading(false);
        }
      },
      (reason: unknown) => {
        if (current) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [native, revision]);

  function reloadAccounts() {
    setLoading(true);
    setRevision((value) => value + 1);
  }

  return (
    <section className="connections" aria-labelledby="connections-heading">
      <div className="connections-content">
        <header className="connections-heading">
          <span className="connections-heading-icon">
            <WorkspaceIcon name="connections" />
          </span>
          <h1 id="connections-heading">Connections</h1>
          <p>Your tools, closer to your thinking.</p>
          <span>Bring GitHub and Jira work into the same place as your notes.</span>
        </header>
        {!native ? (
          <p className="connection-note">
            <WorkspaceIcon name="help" />
            You’re in the web preview. Open Adamant on your desktop to connect accounts securely.
          </p>
        ) : null}
        <div className="connections-services-heading">
          <h2>Your services</h2>
          <span>Choose what belongs in your workspace</span>
        </div>
        {loading ? (
          <p className="connection-loading" role="status">
            <span className="loading-indicator" aria-hidden="true" />
            Loading saved accounts…
          </p>
        ) : null}
        {error ? (
          <div className="connection-error" role="alert">
            <p>Couldn’t load saved accounts. {error}</p>
            <button type="button" disabled={loading} onClick={reloadAccounts}>
              Try again
            </button>
          </div>
        ) : null}
        <div className="connection-services">
          {(['github', 'jira'] as const).map((provider) => (
            <ServiceConnection
              key={provider}
              provider={provider}
              accounts={connections.filter((account) => account.provider === provider)}
              native={native}
              onConnected={reloadAccounts}
            />
          ))}
        </div>
        <div className="connections-footer">
          <section className="connection-trust">
            <WorkspaceIcon name="save" />
            <div>
              <h2>Local by design. Connected by choice.</h2>
              <p>
                Tokens stay in your system’s secure credential store, never in your Vault.
                Connecting an account doesn’t change anything in GitHub or Jira.
              </p>
            </div>
          </section>
          <section className="connection-next">
            <WorkspaceIcon name="board" />
            <div>
              <h2>Next, choose the work to bring in</h2>
              <p>
                In a project workspace, open <strong>Workspace actions → Manage sources</strong> to
                add repositories or Jira projects.
              </p>
              <button type="button" onClick={onWorkspace}>
                Open project workspace <WorkspaceIcon name="forward" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
