import { getCurrentWindow } from '@tauri-apps/api/window';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { native } from './workspaceView';
import type { WorkspaceProps } from './workspaceView';

export default function WindowControls({ workspace }: WorkspaceProps) {
  const desktopWindow = native ? getCurrentWindow() : null;
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
        data-tooltip="Minimize window"
        aria-label="Minimize window"
        disabled={!native}
        onClick={() => void controlWindow('minimize')}
      >
        <WorkspaceIcon name="minimize" />
      </button>
      <button
        className="icon-button"
        type="button"
        data-tooltip="Maximize or restore window"
        aria-label="Maximize or restore window"
        disabled={!native}
        onClick={() => void controlWindow('toggleMaximize')}
      >
        <WorkspaceIcon name="maximize" />
      </button>
      <button
        className="icon-button window-close"
        type="button"
        data-tooltip="Close window"
        aria-label="Close window"
        disabled={!native}
        onClick={workspace.closeWindow}
      >
        <WorkspaceIcon name="close" />
      </button>
    </div>
  );
}
