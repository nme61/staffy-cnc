import { describeState, useMachine } from '../machine/useMachine';
import { webSerialSupported } from '../grbl/webSerial';
import { Button, Card, Details, Note } from '../ui/kit';
import { StaffySays } from '../ui/Staffy';

/** M0 version of the Cut screen: connect, see the machine in plain words, home it.
 *  The guided 8-step walkthrough arrives in M1. */
export function CutScreen({ machine }: { machine: ReturnType<typeof useMachine> }) {
  const { link, status, notice, connect, disconnect, home, unlock, stop, emulator } = machine;

  if (link.kind !== 'connected') {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <StaffySays mood={link.kind === 'failed' ? 'worried' : 'happy'}>
          <p className="text-xl font-semibold">Let’s connect your Cubiko.</p>
          <p className="text-muted">Plug in the USB cable and switch the machine on. Then press the blue button and choose <b>USB-SERIAL CH340</b>.</p>
        </StaffySays>
        {link.kind === 'failed' && <Note tone="stop">{link.message}</Note>}
        {!webSerialSupported() && <Note tone="check">This browser can’t talk to USB machines. Please use Google Chrome or Microsoft Edge.</Note>}
        <div className="flex flex-wrap gap-3">
          <Button kind="next" big disabled={!webSerialSupported() || link.kind === 'connecting'} onClick={() => connect(false)}>
            {link.kind === 'connecting' ? 'Connecting…' : 'Connect my machine'}
          </Button>
          <Button big onClick={() => connect(true)}>Practise with a pretend machine</Button>
        </div>
      </div>
    );
  }

  const d = describeState(status);
  const pos = status?.mpos ?? status?.wpos;
  const needsHome = status?.state === 'Alarm';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-muted">{link.pretend ? 'Pretend Cubiko' : 'Genmitsu Cubiko'}</p>
            <p className="text-3xl font-bold" data-testid="machine-state">{d.title}</p>
          </div>
          <span className={`h-4 w-4 rounded-full ${d.tone === 'ok' ? 'bg-done' : d.tone === 'check' ? 'bg-check' : 'bg-next'}`} />
        </div>
        {pos && (
          <div className="mt-5 grid grid-cols-3 gap-3 text-center">
            {['Left–right', 'Front–back', 'Up–down'].map((label, i) => (
              <div key={label} className="rounded-xl bg-bg p-3">
                <div className="text-sm text-muted">{label}</div>
                <div className="font-mono text-xl tabular-nums">{pos[i]?.toFixed(1)}<span className="text-sm text-muted"> mm</span></div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {notice && <Note tone={notice.tone}>{notice.text}</Note>}

      <div className="flex flex-wrap gap-3">
        {needsHome && <Button kind="next" big onClick={home}>Home the machine</Button>}
        {!needsHome && status?.state === 'Idle' && (
          <div className="flex items-center gap-3">
            <Button kind="next" big disabled>Choose a file to cut</Button>
            <span className="text-muted">Cutting files arrives in the next update.</span>
          </div>
        )}
        {(status?.state === 'Run' || status?.state === 'Home' || status?.state === 'Hold') && (
          <Button kind="stop" big onClick={() => void stop()}>Stop</Button>
        )}
      </div>

      <Details>
        <div className="space-y-3 text-muted">
          <div className="flex flex-wrap gap-2">
            <Button onClick={unlock}>Unlock without homing ($X)</Button>
            <Button onClick={() => void disconnect()}>Disconnect</Button>
          </div>
          {link.pretend && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => emulator.current?.pressLimit('X')}>Pretend: press X limit switch</Button>
              <Button onClick={() => emulator.current?.releaseLimit()}>Pretend: release it</Button>
            </div>
          )}
          <p className="font-mono text-sm">
            {status ? `${status.state}${status.pins ? ' · pins ' + status.pins : ''} · buffer ${status.buffer?.join('/') ?? '?'} · ${machine.session.current?.serialBufferBytes ?? '?'} bytes` : 'No status yet'}
          </p>
        </div>
      </Details>
    </div>
  );
}
