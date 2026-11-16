import { render } from 'preact';
import { App } from './app';
import './styles.css';
import { post } from './vscode';

// The panel's own failures go to Review Desk's log, where a problem report finds them.
window.addEventListener('error', (e) =>
  post({ type: 'error', message: e.message, stack: (e.error as Error | undefined)?.stack }),
);
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as unknown;
  post({
    type: 'error',
    message: `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

render(<App />, document.getElementById('root')!);
