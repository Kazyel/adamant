import { getCurrentWindow } from '@tauri-apps/api/window';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { native } from './workspaceView';
import type { DocumentProps, WorkspaceProps } from './workspaceView';

const desktopWindow = native ? getCurrentWindow() : null;

function WindowControls({ workspace }: WorkspaceProps) {
  async function controlWindow(action: 'minimize' | 'toggleMaximize') {
    if (!desktopWindow) {
      return;
    }

    try {
      await desktopWindow[action]();
    } catch (error) {
      workspace.fail(error);
    }
  }

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        className="icon-button"
        type="button"
        title="Minimize window"
        aria-label="Minimize window"
        disabled={!native}
        onClick={() => void controlWindow('minimize')}
      >
        <WorkspaceIcon name="minimize" />
      </button>
      <button
        className="icon-button"
        type="button"
        title="Maximize or restore window"
        aria-label="Maximize or restore window"
        disabled={!native}
        onClick={() => void controlWindow('toggleMaximize')}
      >
        <WorkspaceIcon name="maximize" />
      </button>
      <button
        className="icon-button window-close"
        type="button"
        title="Close window"
        aria-label="Close window"
        disabled={!native}
        onClick={workspace.closeWindow}
      >
        <WorkspaceIcon name="close" />
      </button>
    </div>
  );
}

export default function WorkspaceTabs({ workspace, navigation, documentInfo }: DocumentProps) {
  const { section, setSection } = navigation;
  const { activePath, activeName } = documentInfo;

  return (
    <header className="workspace-tabs" aria-label="Open workspace views" data-tauri-drag-region>
      <button
        className="workspace-tab"
        type="button"
        aria-pressed={section === 'workbench'}
        onClick={() => setSection('workbench')}
        title={activePath ?? 'Untitled Markdown buffer'}
      >
        <WorkspaceIcon name="document" />
        <span>{activeName}</span>
        {workspace.dirty ? (
          <span className="buffer-dot" aria-label="Unsaved Markdown changes" />
        ) : null}
      </button>
      {section === 'connections' ? (
        <button
          className="workspace-tab"
          type="button"
          aria-pressed="true"
          onClick={() => setSection('connections')}
        >
          <WorkspaceIcon name="connections" />
          <span>Connections</span>
        </button>
      ) : null}
      <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />
      <WindowControls workspace={workspace} />
    </header>
  );
}
