export type LivenessStdout = {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
};

type Stage = "Doctor" | "Frontier" | "Worktree" | "Worker";

type TicketProgress = {
  id: string;
  title: string;
  branch: string;
  started: number;
  cap: number;
};

function ticketLine(info: TicketProgress): string {
  return `Ticket ${info.id}  ${info.title}  ${info.started}/${info.cap}  ${info.branch}`;
}

export type Liveness = {
  stage(name: Stage): void;
  ticket(info: TicketProgress): void;
  stop(): void;
};

const frames = ["◑", "◐", "◒", "◓"];
const clearLine = "\r\x1b[K";
const beatMs = 80;

export function startLiveness(stdout: LivenessStdout): Liveness {
  const tty = stdout.isTTY === true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let label = "";

  function paint(): void {
    const glyph = frames[frame] ?? frames[0];
    frame = (frame + 1) % frames.length;
    stdout.write(`${clearLine}${glyph}  ${label}`);
  }

  function stop(): void {
    if (timer === undefined) {
      return;
    }
    clearInterval(timer);
    timer = undefined;
    stdout.write(clearLine);
  }

  return {
    stage(name) {
      if (!tty) {
        stdout.write(`${name}\n`);
        return;
      }
      // A Worker inherits stdout, so an in-place heartbeat would eat its
      // output. The stage is a durable line instead; the Ticket line above
      // it is already the in-flight indicator.
      if (name === "Worker") {
        stop();
        stdout.write(`${name}\n`);
        return;
      }
      label = name;
      if (timer === undefined) {
        frame = 0;
        paint();
        timer = setInterval(paint, beatMs);
        return;
      }
      paint();
    },
    ticket(info) {
      stop();
      stdout.write(`${ticketLine(info)}\n`);
    },
    stop,
  };
}
