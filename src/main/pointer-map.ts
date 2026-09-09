import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { FitMode } from './pointer-map-rules'

/**
 * The pointer mapper: one long-lived process that puts a streamed tap back on the game.
 *
 * Why this exists is in `pointer-map-rules.ts`. What is here is the machinery around that
 * arithmetic, and every part of it is shaped by one constraint — **it has to run inside a
 * low-level mouse hook**, which is a callback the system dispatches on the thread that
 * installed it and abandons if it takes too long.
 *
 * Three decisions follow from that and none of them are free choices:
 *
 *  - **It is PowerShell, and it is not a native binary.** The hook callback is a C# delegate
 *    compiled by `Add-Type` — JIT'd machine code, not anything the shell interprets — so
 *    PowerShell is only the host and the message pump. That keeps this on the same footing
 *    as every other Win32 query in this program (`window-text.ts`, `playtime.ts`): no native
 *    dependency, and the process on the other end is a Microsoft-signed `powershell.exe`
 *    rather than an unsigned executable of ours installing a global mouse hook, which is
 *    what a scanner is right to be suspicious of.
 *  - **It measures for itself.** Finding the game's window and the upscaler's output window
 *    happens inside this same process, on a timer. Doing it from the main process would mean
 *    spawning a PowerShell on a poll, which is a bug this program has already shipped once
 *    (see `lossless.ts`) — and it would have to happen several times a second, because the
 *    answer changes whenever the window moves.
 *  - **The geometry is written twice.** `pointer-map-rules.ts` is the specification and the
 *    thing the harness pins; the C# below is its transcription. That duplication is
 *    deliberate: the alternative is shipping the numbers over a pipe several times a second
 *    to a process that already has them. If you change one, change the other — the harness
 *    only guards the TypeScript.
 *
 * **Nothing is ever mapped unless the upscaler is demonstrably scaling.** The hook is inert
 * until it can see both an output window covering a whole monitor *and* a game window to
 * map onto, and it only ever touches events the system marks as injected — a mouse plugged
 * into this machine does not carry `LLMHF_INJECTED` and is untouched no matter what this
 * gets wrong.
 *
 * **That last sentence is not the safety argument it looks like**, and reading it as one
 * cost somebody the use of their mouse. A streaming client injects *everything*, moves
 * included, so in the one situation this feature exists for every event goes through the
 * hook. Whatever it decides is what the pointer does. That is why a point on the letterbox
 * is clamped onto the picture rather than dropped (see `PointerVerdict`), and why the two
 * ways out — the game closing, or this program closing — are checked briskly rather than
 * leisurely.
 */

/** How long PowerShell may take to compile the interop stub before we give up on it. */
const START_TIMEOUT_MS = 30_000

/** Our child, when we have one. Null covers "never started" and "it exited". */
let child: ChildProcess | null = null

/** The last line of state the hook reported, for the settings page. */
let state: PointerMapState = { running: false, active: false, mapped: 0, blocked: 0 }

/** Which game the running mapper was aimed at, so a stale aim can be noticed. */
let aimedAt: string | null = null

export interface PointerMapState {
  /** The hook process is alive. */
  running: boolean
  /**
   * It can currently see both windows, so a tap would be mapped.
   *
   * Distinct from `running` on purpose. "Switched on", "started" and "actually mapping"
   * are three different states and only the last one means taps are landing where they
   * look — reporting the first as though it were the third is how somebody concludes the
   * feature is broken when it simply has not been asked to do anything yet.
   */
  active: boolean
  /** Events mapped this session — the one number that says it is doing anything. */
  mapped: number
  /**
   * Button presses the system refused to re-inject, which is a real state and a silent one.
   *
   * `SendInput` is blocked by UIPI when the foreground window belongs to a process of
   * higher integrity than ours — a game launched as administrator from a launcher that was
   * not. The original event has already been swallowed by then, so the press is not
   * misplaced, it is **destroyed**. Counted and surfaced because the alternative is a
   * settings page reporting events as mapped while every click vanishes.
   */
  blocked: number
  /** Why it is not running, when it stopped on its own. Absent is the ordinary case. */
  error?: string
}

export interface PointerMapOptions {
  /**
   * Which game this mapping is for.
   *
   * The mapper is aimed at one game; the upscaler is not. With two scaled games running,
   * the second launch re-points the hook, and without this there is no way to notice that
   * the game it is now aimed at has since closed.
   */
  gameId: string
  /** The game's folder. Any visible window of a process running out of it is a candidate. */
  gameDir: string
  /** The upscaler, so its fullscreen output window can be told from everything else. */
  upscalerExe: string
  /** How the picture is fitted into that window — see `fitModeOf`. */
  fit: FitMode
  /**
   * The multiple, when `fit` is `fixed`. Zero means "not a fixed factor, or unknown" —
   * see `pictureRect`, which falls back rather than guessing one.
   */
  factor: number
}

const FIT_CODE: Record<FitMode, number> = { aspect: 0, integer: 1, stretch: 2, fixed: 3 }

/**
 * The hook, as a script.
 *
 * Written to disk rather than handed over as `-EncodedCommand` the way `window-text.ts`
 * does, and not by preference: base64 UTF-16 is about 2.7 times the source, this script is
 * an order of magnitude longer than that one, and Windows refuses a command line past
 * 32767 characters — the failure is a bare `ENAMETOOLONG` from `spawn`.
 *
 * Two consequences worth knowing. **PowerShell 5.1 reads a `.ps1` without a BOM as ANSI**,
 * so the file is written UTF-8 with one, the same as the sidecar. And the script is a
 * constant with no paths spliced into it — the game folder and the upscaler's path arrive
 * through the environment, which carries Unicode without a quoting rule to get wrong, and
 * which keeps the file on disk identical from one launch to the next.
 */
export const POINTER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SakuraPointer {
  // ---- configuration, filled in before Run() ----------------------------------------
  public static string GameDir = "";
  public static string UpscalerExe = "";
  public static int Fit = 0;              // 0 aspect, 1 integer, 2 stretch, 3 fixed
  public static double Factor = 0;        // the multiple, when Fit is 3
  public static int ParentPid = 0;
  /*
   * Where this writes down what it is actually doing. Not a log and not optional: the hook
   * runs in a process nobody sees, and the failure that matters — measuring the wrong
   * window, so every point maps into some tiny rectangle and the pointer appears frozen —
   * looks identical from outside to the hook being broken. Without this file the only way
   * to tell them apart is to guess.
   */
  public static string StatePath = "";
  /*
   * The event log, and it exists because the summary above cannot settle the question it
   * raised. A census says a button arrived and was mapped; it cannot say that the
   * coordinate the client sent was the one this program had just placed the cursor at, and
   * that the classification therefore read every tap as a zero-length drag. Two mechanisms
   * produce exactly that reading — a client that polls the cursor before sending a button,
   * and a client injecting relative motion, where the pt a low-level hook receives is the
   * position the system has already computed — and they want opposite fixes. Only the
   * sequence tells them apart, so the sequence is written down.
   *
   * Bounded, and cheap: one preformatted string per injected event into a ring, flushed by
   * the worker. Our own re-injections never reach it.
   */
  public static string TracePath = "";
  static readonly string NL = Environment.NewLine;
  static volatile string _lastMap = "(none yet)";
  static volatile string _why = "starting";
  // What Verdict decided and what it was measuring when it decided, published for the
  // trace line the callback writes straight afterwards.
  static volatile string _vwhy = "start";
  static int _dLast = -1, _fromX = 0, _fromY = 0;
  static bool _fromPlaced = false;
  static string[] _trace = new string[600];
  static volatile int _traceAt = 0;
  static int _traceSeq = 0;
  static uint _t0 = 0;
  public static int RingMoves = 0;
  static void Trace(string line) {
    int at = _traceAt;
    _trace[at] = _traceSeq + "  " + line;
    _traceSeq++;
    _traceAt = (at + 1) % _trace.Length;
  }

  /*
   * Tap versus drag. A combined remote client sends both down one wire: a tap names a
   * position, a press-and-drag behaves like a trackpad. Mapping is required for the first
   * and fatal for the second, because mapping is a compression and a compression has a
   * fixed point — relative steps run through it converge there and the pointer stops dead.
   * Measured on the real case: it parked at (55,105), the top-left of the picture.
   *
   * We can tell them apart because we know where we last put the pointer: a drag step is
   * measured from there and lands near it, a tap names somewhere else. In a real session
   * the populations do not overlap — drags reached 96px, the smallest tap jump was 129px.
   *
   * _v is the virtual pointer, in *screen* space. A drag adds the client's step to it at
   * full size and mapping then divides by the scale, so the pointer moves half as far in a
   * game enlarged 2x and the upscaler magnifies that back to the step the finger made.
   * Accumulating in game space would halve every drag and make it feel heavy.
   *
   * Transcribed from pointer-map-rules.ts, which is the specification the harness pins.
   */
  const int TAP_DIST = 110;
  // Volatile because the ring's thread reads them; see the marker section below.
  static volatile int _vx = 0;
  static volatile int _vy = 0;
  static int _ax = 0, _ay = 0;
  static int _px = -1, _py = -1;   // where we last actually put the pointer on screen
  static bool _placed = false;
  public static int Taps = 0, Drags = 0;
  /* Presses the system refused to re-inject. See the note at the call site. */
  public static int Blocked = 0;
  static volatile string _lastFail = "(none)";
  /*
   * How far behind the events are. MSLLHOOKSTRUCT carries the tick the event was produced
   * at, so this is the queue depth in milliseconds — the one number that says whether the
   * hook is keeping up. Reported as "the pointer lags by several seconds" the first time,
   * with nothing on screen able to confirm it.
   */
  public static int LagNow = 0, LagMax = 0;
  /*
   * A census of what the client actually injects, by kind, counted as mapped/seen. It is
   * here because "the right button does nothing" and "the right button works and the
   * picture is two seconds behind it" look identical from the sofa, and only one of them
   * is something this program can do anything about. A kind with seen=0 was never sent by
   * the client at all; a kind with seen>0 and sent=0 is ours to fix.
   */
  public static int[] Seen = new int[8];
  public static int[] Sent = new int[8];
  /*
   * The same census taken one step earlier: every mouse event on the machine, counted
   * before the injected filter. It answers a question the census above structurally
   * cannot. A kind reading seen 0 there has two completely different causes — the client
   * never sent it, or the client sent it without LLMHF_INJECTED — and the two point at
   * opposite fixes: one is a client that cannot do it, the other is a filter of ours that
   * cannot see it. Raw separates them. Raw climbing while seen stays at zero is an event
   * arriving unflagged, and nothing inside the mapping would ever have revealed that.
   * It counts a hand on a real mouse too; that is the baseline which makes it readable.
   */
  public static int[] Raw = new int[8];
  // Which kinds SendInput refused. The last message says what went wrong; this says
  // whether it went wrong for one button or for all of them.
  public static int[] BlockedKind = new int[8];
  /*
   * The tap-versus-drag distance, bucketed in twenties. TAP_DIST is a measurement rather
   * than a constant of nature: it came from one client on one screen, where drags reached
   * 96px and the smallest tap jump was 129. Another resolution or another client moves
   * both populations, and what follows is silent — a tap read as a drag walks the pointer
   * instead of placing it, a drag read as a tap teleports it. Without the distribution
   * there is nothing to re-derive the threshold from, and the report is only that the
   * pointer misbehaves again.
   */
  public static int[] Dist = new int[11];
  static volatile string _nearMiss = "(none)";
  public static int NearCount = 0;
  /*
   * The last few button mappings, and only buttons. One line cannot answer "I tapped
   * there and it landed here", because by the time that is said several more events have
   * overwritten it. Moves are left out deliberately: they arrive in thousands and would
   * push out the one line worth reading. Single writer, no lock — a reference assignment
   * is atomic, and nothing in the callback may ever block.
   */
  static string[] _recent = new string[12];
  static volatile int _recentAt = 0;
  static void Remember(string line) {
    int at = _recentAt;
    _recent[at] = line;
    _recentAt = (at + 1) % _recent.Length;
  }
  static volatile string _lastOther = "(none)";
  static int KindOf(int msg) {
    switch (msg) {
      case 0x0200: return 0;
      case 0x0201: case 0x0202: case 0x0203: return 1;
      case 0x0204: case 0x0205: case 0x0206: return 2;
      case 0x0207: case 0x0208: case 0x0209: return 3;
      case 0x020A: return 4;
      case 0x020E: return 5;
      case 0x020B: case 0x020C: case 0x020D: return 6;
      default: return 7;
    }
  }

  // ---- interop -----------------------------------------------------------------------
  public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public uint pad; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookExW(int id, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int cb);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr fn);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref int size);
  // ...and the ring, which needs a window of its own.
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pos, ref SIZE size, IntPtr src, ref POINT srcPos, uint key, ref BLENDFUNCTION blend, uint flags);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential, Pack=1)] public struct BLENDFUNCTION { public byte Op, Flags, Alpha, Format; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO {
    public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
    public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter;
    public uint biClrUsed, biClrImportant;
  }

  const int WH_MOUSE_LL = 14;
  const uint LLMHF_INJECTED = 0x01;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, XDOWN = 0x0080, XUP = 0x0100;
  const uint WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  // Our own re-injected events carry this in dwExtraInfo so the hook can recognise them
  // and let them past. Without it every mapped event would be mapped again, forever.
  static readonly IntPtr SIG = new IntPtr(0x53414B55);   // 'SAKU'

  // ---- measured state ----------------------------------------------------------------
  /*
   * One immutable snapshot behind a volatile reference, and that shape is load-bearing.
   *
   * Measuring and pumping used to share a thread, on the reasoning that a low-level hook is
   * dispatched on the thread that installed it, so there could be no race. True, and beside
   * the point: **the callback cannot be dispatched while that thread is busy measuring.**
   * Refresh() walks every top-level window and opens every owning process; that is tens to
   * hundreds of milliseconds during which no PeekMessage runs, and the whole mouse input
   * chain waits behind it. Every 400ms, the pointer froze. It did not matter whether an
   * event would have been mapped or even looked at — a real mouse on the desk stuttered
   * just as badly. Reported as "the mouse cannot move".
   *
   * So measuring runs on its own thread now and the pump thread does nothing but pump. The
   * two meet here: the measuring thread builds a whole new Geom and assigns it; the callback
   * reads the reference once. A reference assignment is atomic, so the callback can never
   * see half of a rectangle — which a struct field written in place absolutely can.
   */
  public class Geom {
    public RECT Src, Out;
    public bool Active;
    /* Kept so the output window can be re-checked without another full sweep. */
    public IntPtr OutHwnd;
  }

  static volatile Geom _geom = new Geom();
  static string _lastReport = "";
  public static int Mapped = 0;

  // ---- geometry ----------------------------------------------------------------------
  // Transcribed from pointer-map-rules.ts. That file is the specification and the one the
  // harness pins; keep the two in step.
  /*
   * Half-up, because that is what JavaScript's Math.round does and this file is a
   * transcription of one written in it. C#'s Math.Round is banker's rounding: it breaks a
   * tie towards the even number, so the two disagree whenever the argument is exactly .5 —
   * which is every odd remainder. A 1288x724 client area on a 2560x1440 screen fits to
   * 1439 high, remainder 1, and the two copies then place the picture a pixel apart. One
   * pixel is harmless; two specifications that quietly differ are not, because the harness
   * only guards one of them.
   */
  static int Round(double v) { return (int)Math.Floor(v + 0.5); }

  static void Picture(RECT src, RECT outr, out int px, out int py, out int pw, out int ph) {
    int sw = src.R - src.L, sh = src.B - src.T;
    int ow = outr.R - outr.L, oh = outr.B - outr.T;
    if (sw <= 0 || sh <= 0 || ow <= 0 || oh <= 0 || Fit == 2) {
      px = outr.L; py = outr.T; pw = ow; ph = oh; return;
    }
    double scale;
    if (Fit == 3 && Factor > 0) {
      // A profile that names its own multiple owes the screen nothing: it is not clamped
      // to fit, and the edges fall off if it does not. A Fit of 3 with no factor falls
      // through to the proportional fit rather than inventing one.
      scale = Factor;
    } else {
      scale = Math.Min((double)ow / sw, (double)oh / sh);
      if (Fit == 1) scale = Math.Max(1, Math.Floor(scale));
    }
    pw = Round(sw * scale);
    ph = Round(sh * scale);
    px = outr.L + Round((ow - pw) / 2.0);
    py = outr.T + Round((oh - ph) / 2.0);
  }

  static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // MIN_SOURCE in pointer-map-rules.ts, which is where the reasoning lives and where the
  // harness pins it. It was only ever here for a while, which made it deletable without a
  // single test failing.
  const int MIN_SOURCE = 200;

  // 0 = pass it through, 1 = map to (mx,my). There is deliberately no third answer —
  // see PointerVerdict in pointer-map-rules.ts. Dropping an event on the letterbox
  // deadlocks the pointer there, because the moves that would carry it off the letterbox
  // are the very events being dropped.
  static int Verdict(int x, int y, out int mx, out int my) {
    mx = x; my = y;
    // What the decision below is being measured against, captured before it is overwritten.
    _fromPlaced = _placed; _fromX = _ax; _fromY = _ay; _dLast = -1;
    // Read once. Everything below works off this one snapshot, so a refresh landing
    // mid-callback cannot change the answer halfway through it.
    Geom g = _geom;
    // Any path that declines to map also forgets where the pointer was placed: the next
    // event cannot be a continuation of a step we did not take.
    if (g == null || !g.Active) { _placed = false; _vwhy = "PASS not scaling"; return 0; }
    int sw = g.Src.R - g.Src.L, sh = g.Src.B - g.Src.T;
    if (sw <= 0 || sh <= 0) { _placed = false; _vwhy = "PASS empty source"; return 0; }
    /*
     * A window this small is not the game, it is something we misidentified — a tooltip, a
     * splash, an off-screen helper. Mapping into it compresses the whole screen into a few
     * pixels, which does not look like a wrong mapping: it looks like the pointer has
     * stopped moving entirely. Refusing is the only safe answer, and 200px is well under
     * any window worth scaling.
     */
    if (sw < MIN_SOURCE || sh < MIN_SOURCE) { _placed = false; _vwhy = "PASS source too small"; return 0; }
    if (x < g.Out.L || x >= g.Out.R || y < g.Out.T || y >= g.Out.B) { _placed = false; _vwhy = "PASS off the output window"; return 0; }
    int px, py, pw, ph; Picture(g.Src, g.Out, out px, out py, out pw, out ph);
    if (pw == sw && ph == sh) { _placed = false; _vwhy = "PASS nothing enlarged"; return 0; }

    bool drag = false;
    if (_placed) {
      int ddx = x - _ax, ddy = y - _ay;
      // Observation only: the classification below is unchanged, and reads the squared
      // distance exactly as it always did.
      int d = (int)Math.Sqrt((double)(ddx * ddx + ddy * ddy));
      _dLast = d;
      int b = d / 20; if (b > 10) b = 10;
      Dist[b]++;
      // The band where the answer is a judgement rather than a certainty. A test that
      // fills this band is a test whose threshold needs re-deriving.
      if (d >= 70 && d <= 160) { NearCount++; _nearMiss = d + "px"; }
      if (ddx * ddx + ddy * ddy < TAP_DIST * TAP_DIST) drag = true;
    }
    if (drag) {
      _vx = Clamp(_vx + (x - _ax), g.Out.L, g.Out.R - 1);
      _vy = Clamp(_vy + (y - _ay), g.Out.T, g.Out.B - 1);
      Drags++;
    } else {
      _vx = Clamp(x, g.Out.L, g.Out.R - 1);
      _vy = Clamp(y, g.Out.T, g.Out.B - 1);
      Taps++;
    }

    int cx = Clamp(_vx, px, px + pw - 1), cy = Clamp(_vy, py, py + ph - 1);
    double u = (double)(cx - px) / pw, v = (double)(cy - py) / ph;
    mx = g.Src.L + Math.Min(sw - 1, (int)Math.Floor(u * sw));
    my = g.Src.T + Math.Min(sh - 1, (int)Math.Floor(v * sh));
    _ax = mx; _ay = my; _placed = true;
    _vwhy = drag ? "drag" : "tap ";
    _lastMap = (drag ? "drag " : "tap   ") + x + "," + y + "  ->  " + mx + "," + my + "   virtual " + _vx + "," + _vy;
    return 1;
  }

  // ---- the hook ----------------------------------------------------------------------
  static IntPtr _hook = IntPtr.Zero;
  static HookProc _fn;   // a static field so the GC cannot collect the delegate under us
  static volatile bool _stopping = false;
  static uint _pumpThread = 0;

  static IntPtr Callback(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      /*
       * Read the fields out directly rather than marshalling the struct. PtrToStructure
       * boxes an object for every mouse event on the machine, and this callback is on the
       * path of all of them. x64 layout: pt.x 0, pt.y 4, mouseData 8, flags 12, time 16,
       * dwExtraInfo 24 (the pointer is 8-aligned, so 20 is padding).
       */
      int ex = Marshal.ReadInt32(lParam, 0);
      int ey = Marshal.ReadInt32(lParam, 4);
      uint emouse = (uint)Marshal.ReadInt32(lParam, 8);
      uint eflags = (uint)Marshal.ReadInt32(lParam, 12);
      uint etime = (uint)Marshal.ReadInt32(lParam, 16);
      IntPtr eextra = Marshal.ReadIntPtr(lParam, 24);

      int kind = KindOf((int)wParam);
      // Counted outside the filter on purpose — see the note on Raw. Our own re-injected
      // events are still excluded, or every button we send would be counted as one the
      // client sent.
      if (eextra != SIG) Raw[kind]++;

      // Only injected events, and never our own. A hand on a real mouse produces neither,
      // which is what keeps this from being able to break ordinary use at all.
      if ((eflags & LLMHF_INJECTED) != 0 && eextra != SIG) {
        int lag = unchecked((int)(GetTickCount() - etime));
        if (lag >= 0 && lag < 60000) { LagNow = lag; if (lag > LagMax) LagMax = lag; }

        Seen[kind]++;
        if (kind == 7) _lastOther = "0x" + ((int)wParam).ToString("X4");

        /*
         * Decided before Verdict runs, because Verdict *commits*: it writes the virtual
         * pointer and records where we placed the cursor. An event we cannot reproduce
         * falls through to CallNextHookEx unmapped, and a commit for it leaves the next
         * event's tap-versus-drag test measured from a screen position the cursor is not
         * at — which is the classification whose failure parks the pointer on the fixed
         * point. Nothing a low-level mouse hook receives is currently unrecognised, and
         * the unknown bucket in the census exists precisely because that is an assumption.
         */
        uint flags = (int)wParam == 0x0200 ? MOUSEEVENTF_MOVE : Buttons((int)wParam, emouse);
        if (flags == 0) return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);

        int mx, my; int verdict = Verdict(ex, ey, out mx, out my);
        /*
         * Written here rather than inside Verdict because this is the only place that
         * knows all of it at once: the raw event, what Verdict was measuring, what it
         * decided, and the geometry it decided against. Formatting one string per injected
         * event is a few microseconds on a path that already calls SendInput, and our own
         * re-injections never get here.
         */
        if (TracePath.Length > 0) {
          try {
            Geom tg = _geom;
            Trace("t=" + unchecked((int)(GetTickCount() - _t0)) + "ms lag=" + lag
              + " msg=0x" + ((int)wParam).ToString("X4") + " f=0x" + eflags.ToString("X2")
              + " data=0x" + emouse.ToString("X8")
              + " raw=" + ex + "," + ey
              + " | placed=" + (_fromPlaced ? "1" : "0") + " from=" + _fromX + "," + _fromY
              + " d=" + _dLast
              + " | " + _vwhy + " out=" + mx + "," + my + " virt=" + _vx + "," + _vy
              + " | " + (tg == null || !tg.Active ? "inactive"
                  : "src=" + tg.Src.L + "," + tg.Src.T + " " + (tg.Src.R - tg.Src.L) + "x" + (tg.Src.B - tg.Src.T)
                  + " out=" + tg.Out.L + "," + tg.Out.T + " " + (tg.Out.R - tg.Out.L) + "x" + (tg.Out.B - tg.Out.T)));
          } catch { }
        }
        _markerOn = verdict == 1;
        if (verdict == 1) {
          /*
           * A move is applied with SetCursorPos and the original swallowed. This is the
           * whole of the latency fix: SendInput from inside a low-level hook puts another
           * event on a queue that is drained through this same callback, so every move
           * costs two passes and the backlog compounds — measured as a multi-second lag.
           * SetCursorPos does not raise a low-level hook event at all (verified: a probe
           * parking the cursor with it saw nothing), so the high-frequency path now
           * produces no new work whatsoever.
           */
          if ((int)wParam == 0x0200) {
            if (mx != _px || my != _py) { SetCursorPos(mx, my); _px = mx; _py = my; }
            Mapped++; Sent[kind]++;
            return (IntPtr)1;
          }
          /*
           * Buttons still go through SendInput: the press has to be a real input event,
           * and it must carry the position or the click lands wherever the pointer was.
           *
           * The return value is checked, and what it means is worth stating. UIPI refuses
           * SendInput when the foreground window belongs to a process of higher integrity
           * — a game started as administrator, from a launcher that was not — and by that
           * point the original event has already been swallowed. So the press is not
           * landing in the wrong place: it has been **destroyed**, silently, while every
           * counter here says it was mapped. The event is still not passed on (letting it
           * through would put an unmapped click on whatever else is under the finger,
           * which is the harm this whole feature exists to prevent), but it is counted
           * apart and reported, because a click that goes nowhere with nothing said is
           * indistinguishable from the hook being broken.
           */
          if (Send(mx, my, flags, emouse)) { _px = mx; _py = my; Mapped++; Sent[kind]++; Remember(_lastMap); }
          else {
            Blocked++; BlockedKind[kind]++;
            _lastFail = "SendInput refused (" + Marshal.GetLastWin32Error() + ")";
            Remember(_lastMap + "   REFUSED");
          }
          return (IntPtr)1;
        }
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }

  // Which SendInput flags reproduce this window message. Zero means "not something we
  // know how to reproduce", and an event we cannot reproduce is passed through untouched
  // rather than swallowed — dropping input we merely failed to recognise would be worse
  // than leaving it where it landed.
  static uint Buttons(int msg, uint mouseData) {
    switch (msg) {
      case 0x0200: return MOUSEEVENTF_MOVE;
      case 0x0201: return MOUSEEVENTF_MOVE | LEFTDOWN;
      case 0x0202: return MOUSEEVENTF_MOVE | LEFTUP;
      case 0x0204: return MOUSEEVENTF_MOVE | RIGHTDOWN;
      case 0x0205: return MOUSEEVENTF_MOVE | RIGHTUP;
      case 0x0207: return MOUSEEVENTF_MOVE | MIDDLEDOWN;
      case 0x0208: return MOUSEEVENTF_MOVE | MIDDLEUP;
      case 0x020B: return MOUSEEVENTF_MOVE | XDOWN;
      case 0x020C: return MOUSEEVENTF_MOVE | XUP;
      case 0x020A: return MOUSEEVENTF_MOVE | WHEEL;
      case 0x020E: return MOUSEEVENTF_MOVE | HWHEEL;
      default: return 0;
    }
  }

  static bool Send(int x, int y, uint flags, uint mouseData) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    if (vw <= 1 || vh <= 1) return false;
    INPUT[] inp = new INPUT[1];
    inp[0].type = 0;
    inp[0].mi.dx = (int)(((long)(x - vx) * 65535) / (vw - 1));
    inp[0].mi.dy = (int)(((long)(y - vy) * 65535) / (vh - 1));
    /*
     * A wheel notch and an X button both live in the high word of mouseData, and the two
     * are not read the same way. An X button is an index. A wheel notch is **signed** —
     * a notch backwards is -120 — so shifting it down as an unsigned word hands SendInput
     * 65416, which is not a small scroll backwards but an enormous one forwards. A plain
     * move or click has nothing in that word at all and must send zero.
     */
    if ((flags & (WHEEL | HWHEEL)) != 0) inp[0].mi.mouseData = unchecked((uint)(int)(short)(mouseData >> 16));
    else if ((flags & (XDOWN | XUP)) != 0) inp[0].mi.mouseData = mouseData >> 16;
    else inp[0].mi.mouseData = 0;
    inp[0].mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    inp[0].mi.dwExtraInfo = SIG;
    return SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  // ---- finding the two windows -------------------------------------------------------
  static string PathOf(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      int cap = 1024; StringBuilder sb = new StringBuilder(cap);
      if (!QueryFullProcessImageNameW(h, 0, sb, ref cap)) return "";
      return sb.ToString();
    } finally { CloseHandle(h); }
  }

  static bool Under(string path, string dir) {
    if (path.Length == 0 || dir.Length == 0) return false;
    string d = dir.EndsWith("\\\\") ? dir : dir + "\\\\";
    return path.StartsWith(d, StringComparison.OrdinalIgnoreCase);
  }

  /**
   * One sweep of the visible top-level windows.
   *
   * The output window is identified by covering a whole monitor exactly, not by class name
   * and not by being the biggest: the upscaler's own settings window belongs to the same
   * process, and a class name is an implementation detail that changes under us on any
   * update. A window whose rectangle *is* a monitor's rectangle is the scaling output and
   * nothing else is.
   *
   * The source is the largest client area belonging to a process running out of the game's
   * folder — the same test playtime.ts uses, and for the same reason: these games routinely
   * hand off to a second executable, so the process that ends up owning the window is very
   * often not the one that was launched.
   */
  static void Refresh() {
    RECT src = new RECT(), outr = new RECT();
    bool haveOut = false; long best = 0;
    IntPtr outHwnd = IntPtr.Zero;

    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == 0) return true;
      string path = PathOf(pid);
      if (path.Length == 0) return true;

      if (!haveOut && string.Equals(path, UpscalerExe, StringComparison.OrdinalIgnoreCase)) {
        RECT wr; if (!GetWindowRect(h, out wr)) return true;
        MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        IntPtr mon = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
        if (mon != IntPtr.Zero && GetMonitorInfoW(mon, ref mi)) {
          if (wr.L == mi.rcMonitor.L && wr.T == mi.rcMonitor.T && wr.R == mi.rcMonitor.R && wr.B == mi.rcMonitor.B) {
            outr = wr; haveOut = true; outHwnd = h;
          }
        }
        return true;
      }

      if (Under(path, GameDir)) {
        RECT cr; if (!GetClientRect(h, out cr)) return true;
        long area = (long)(cr.R - cr.L) * (cr.B - cr.T);
        if (area > best) {
          POINT o = new POINT(); o.x = 0; o.y = 0;
          if (ClientToScreen(h, ref o)) {
            best = area;
            src.L = o.x; src.T = o.y; src.R = o.x + (cr.R - cr.L); src.B = o.y + (cr.B - cr.T);
          }
        }
      }
      return true;
    }, IntPtr.Zero);

    Geom next = new Geom();
    next.Src = src; next.Out = outr; next.OutHwnd = outHwnd;
    next.Active = haveOut && best > 0;
    _geom = next;

    _why = haveOut
      ? (best > 0 ? "both windows found" : "output window found, no game window under GameDir")
      : (best > 0 ? "game window found, no fullscreen window belonging to UpscalerExe" : "neither window found");

    string report = next.Active
      ? "{\\"active\\":true,\\"src\\":[" + src.L + "," + src.T + "," + (src.R - src.L) + "," + (src.B - src.T) + "],\\"out\\":[" + outr.L + "," + outr.T + "," + (outr.R - outr.L) + "," + (outr.B - outr.T) + "]}"
      : "{\\"active\\":false}";
    if (report != _lastReport) { _lastReport = report; Console.WriteLine(report); Console.Out.Flush(); }
  }

  /*
   * Is the output window still there, and still covering the monitor?
   *
   * Two calls against a handle we already hold — microseconds — as against Refresh(),
   * which walks every top-level window on the machine and opens every owning process.
   * That difference is the point. "The game closed" is one of the two documented ways out
   * of a mapping that has gone wrong, and how long it takes is how long somebody sits
   * there unable to use their mouse; a full sweep is far too expensive to run at the rate
   * that promise needs, and running it faster is what froze the pointer in the first place.
   * So the expensive sweep keeps its own pace and this rides the sleep between them.
   */
  static bool StillScaling() {
    Geom g = _geom;
    if (g == null || !g.Active || g.OutHwnd == IntPtr.Zero) return false;
    if (!IsWindow(g.OutHwnd) || !IsWindowVisible(g.OutHwnd)) return false;
    RECT wr;
    if (!GetWindowRect(g.OutHwnd, out wr)) return false;
    return wr.L == g.Out.L && wr.T == g.Out.T && wr.R == g.Out.R && wr.B == g.Out.B;
  }

  /* Stop mapping now, without waiting for the next sweep to agree. */
  static void GoInert(string why) {
    Geom g = _geom;
    if (g == null || !g.Active) return;
    Geom next = new Geom();
    next.Src = g.Src; next.Out = g.Out; next.OutHwnd = g.OutHwnd;
    next.Active = false;
    _geom = next;
    _markerOn = false;
    _why = why;
    try {
      if (_lastReport != "{\\"active\\":false}") {
        _lastReport = "{\\"active\\":false}";
        Console.WriteLine(_lastReport);
        Console.Out.Flush();
      }
    } catch { }
  }

  /*
   * A handle opened once, waited on with a zero timeout. Process.GetProcessById allocates
   * on every call and this is asked several times a second; more to the point it throws,
   * and the version that used it was inside the one loop that could die.
   */
  static IntPtr _parentHandle = IntPtr.Zero;
  const uint SYNCHRONIZE = 0x00100000;

  static bool ParentAlive() {
    if (ParentPid <= 0) return true;
    if (_parentHandle == IntPtr.Zero) {
      _parentHandle = OpenProcess(SYNCHRONIZE, false, (uint)ParentPid);
      // Cannot even open it: it is already gone, or it is out of reach and we must not
      // outlive it on a guess.
      if (_parentHandle == IntPtr.Zero) return false;
    }
    return WaitForSingleObject(_parentHandle, 0) != 0;   // 0 == WAIT_OBJECT_0 == exited
  }

  // ---- the ring ----------------------------------------------------------------------
  /*
   * A small ring drawn where the finger is, on its own topmost layered window.
   *
   * It is not decoration, and it is not a second cursor for the sake of one. The picture
   * the remote client shows is a **capture of a still page**, and everything about a
   * cursor on it is downstream of that: the pointer baked into a WGC frame is a
   * photograph, so it moves only when the game redraws, and a visual novel redraws when
   * it is clicked and at no other time. That is the whole of "I can only see the pointer
   * move at the moment I let go" — the release advanced the text, the text produced a
   * frame, and the frame carried the pointer to where it had been all along. The hook was
   * never behind: the queue lag measured 0 ms, worst 16.
   *
   * The ring is ours, it is not inside the captured window, and it moves when we move it.
   * Two things follow, and the second is the one that also explains the two seconds:
   *
   * 1. It shows where a tap will land *before* the tap, which is the only thing that makes
   *    a still page usable from a sofa.
   * 2. Moving it changes the desktop, and a desktop that changes is one the streaming
   *    client keeps sending. Left alone, a static screen puts these clients into a very
   *    low idle frame rate that takes a moment to come back up, which is felt as a delay
   *    on the *reply* rather than on the touch.
   *
   * Constraints it has to respect:
   * - **Its own thread.** Not the pump — see the note on Geom — and not the worker, which
   *   blocks for tens of milliseconds inside Refresh(). SetWindowPos on a window owned by
   *   a busy thread waits for that thread.
   * - **Nothing added to the callback.** The ring reads the virtual pointer on a timer; the
   *   hook path is untouched, which is why it cannot bring the lag back.
   * - **It moves only when the position changed.** A ring parked still and rewritten 125
   *   times a second would keep the whole desktop awake for nothing.
   * - **Click-through and never activated** (WS_EX_TRANSPARENT, WS_EX_NOACTIVATE), or it
   *   would eat the taps it exists to aim.
   * - **Not hidden from capture.** The remote client has to see it — that is the point —
   *   and Lossless Scaling will not, because it captures the game's window and this is a
   *   separate top-level one.
   */
  static volatile bool _markerOn = false;
  static volatile string _marker = "not started";
  const int RING = 34;

  /* A ring with a dot in it: it says where the finger is without covering it up. */
  static void PaintRing(IntPtr bits) {
    double c = (RING - 1) / 2.0;
    for (int y = 0; y < RING; y++) {
      for (int x = 0; x < RING; x++) {
        double dx = x - c, dy = y - c;
        double d = Math.Sqrt(dx * dx + dy * dy);
        int argb = 0;                                            // transparent
        if (d <= 2.2) argb = unchecked((int)0xFFFFFFFF);         // the dot
        else if (d <= 3.6) argb = unchecked((int)0xFF000000);    // its rim
        else if (d >= 8.0 && d <= 10.4) argb = unchecked((int)0xFFFFFFFF);
        else if ((d > 6.4 && d < 8.0) || (d > 10.4 && d <= 12.0)) argb = unchecked((int)0xFF000000);
        // Premultiplied, which for pure white and pure black at full alpha is the value
        // itself. UpdateLayeredWindow accepts nothing else.
        Marshal.WriteInt32(bits, (y * RING + x) * 4, argb);
      }
    }
  }

  const uint WS_POPUP = 0x80000000;
  const uint WS_EX_LAYERED = 0x00080000, WS_EX_TRANSPARENT = 0x00000020, WS_EX_TOPMOST = 0x00000008;
  const uint WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x00000080;
  const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;

  static void MarkerLoop() {
    IntPtr h = IntPtr.Zero, dib = IntPtr.Zero, mem = IntPtr.Zero, old = IntPtr.Zero, screen = IntPtr.Zero;
    try {
      // The predefined "Static" class, because a layered window painted through
      // UpdateLayeredWindow never asks its class to draw anything — which saves
      // registering one, and with it a second delegate to keep alive.
      h = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                          "Static", "", WS_POPUP, 0, 0, RING, RING,
                          IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      if (h == IntPtr.Zero) { _marker = "window failed (" + Marshal.GetLastWin32Error() + ")"; return; }

      screen = GetDC(IntPtr.Zero);
      mem = CreateCompatibleDC(screen);
      BITMAPINFO bi = new BITMAPINFO();
      bi.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFO));
      bi.biWidth = RING; bi.biHeight = -RING;   // negative: top-down, so y counts downwards
      bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0;
      IntPtr bits;
      dib = CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);
      if (dib == IntPtr.Zero) { _marker = "bitmap failed"; return; }
      old = SelectObject(mem, dib);
      PaintRing(bits);

      POINT pos = new POINT(); POINT src = new POINT();
      SIZE sz = new SIZE(); sz.cx = RING; sz.cy = RING;
      BLENDFUNCTION bf = new BLENDFUNCTION();
      bf.Op = 0; bf.Flags = 0; bf.Alpha = 255; bf.Format = 1;   // AC_SRC_ALPHA
      // ULW_ALPHA. Done once: the picture never changes, only where it sits.
      UpdateLayeredWindow(h, screen, ref pos, ref sz, mem, ref src, 0, ref bf, 2);
      _marker = "on";

      SetTimer(h, new IntPtr(1), 8, IntPtr.Zero);
      MSG m;
      bool shown = false;
      int lx = int.MinValue, ly = int.MinValue;
      while (!_stopping && GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) {
        try {
          if (m.message != 0x0113) { DispatchMessageW(ref m); continue; }   // WM_TIMER
          if (!_markerOn) { if (shown) { ShowWindow(h, 0); shown = false; } continue; }
          int nx = _vx - RING / 2, ny = _vy - RING / 2;
          if (nx == lx && ny == ly && shown) continue;
          lx = nx; ly = ny;
          SetWindowPos(h, IntPtr.Zero, nx, ny, 0, 0,
                       SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | (shown ? 0u : SWP_SHOWWINDOW));
          shown = true;
          // Counted because "I never saw the ring" has two causes that look the same from
          // the sofa: a ring that was never placed, and a ring placed once and then frozen
          // because the thing driving it stopped moving. This separates them.
          RingMoves++;
        } catch { }
      }
    } catch (Exception ex) { _marker = "threw: " + ex.Message; }
    finally {
      try { if (h != IntPtr.Zero) DestroyWindow(h); } catch { }
      try { if (mem != IntPtr.Zero && old != IntPtr.Zero) SelectObject(mem, old); } catch { }
      try { if (dib != IntPtr.Zero) DeleteObject(dib); } catch { }
      try { if (mem != IntPtr.Zero) DeleteDC(mem); } catch { }
      try { if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen); } catch { }
    }
  }

  // ---- the loop ----------------------------------------------------------------------
  static string StateText() {
    Geom g = _geom;
    int sw = g == null ? 0 : g.Src.R - g.Src.L, sh = g == null ? 0 : g.Src.B - g.Src.T;
    int ow = g == null ? 0 : g.Out.R - g.Out.L, oh = g == null ? 0 : g.Out.B - g.Out.T;
    string s = "";
    s += "gameDir      : " + GameDir + NL;
    s += "upscalerExe  : " + UpscalerExe + NL;
    s += "fit          : " + Fit + "  (0 aspect, 1 integer, 2 stretch, 3 fixed)"
       + (Fit == 3 ? "  factor " + Factor : "") + NL;
    s += "active       : " + (g != null && g.Active ? "YES" : "no") + NL;
    s += "why          : " + _why + NL;
    s += "source rect  : " + (g == null ? "-" : g.Src.L + "," + g.Src.T + " size " + sw + "x" + sh) + NL;
    s += "output rect  : " + (g == null ? "-" : g.Out.L + "," + g.Out.T + " size " + ow + "x" + oh) + NL;
    if (g != null && g.Active && sw > 0 && sh > 0 && ow > 0 && oh > 0) {
      int px, py, pw, ph; Picture(g.Src, g.Out, out px, out py, out pw, out ph);
      s += "picture rect : " + px + "," + py + " size " + pw + "x" + ph + NL;
      s += "guard        : " + (sw < MIN_SOURCE || sh < MIN_SOURCE ? "REFUSING - source too small to be a game window" : (pw == sw && ph == sh ? "REFUSING - nothing is being enlarged" : "mapping")) + NL;
    }
    s += "events mapped: " + Mapped + "   taps: " + Taps + "   drags: " + Drags + NL;
    s += "queue lag ms : " + LagNow + "   worst seen: " + LagMax + NL;
    // mapped/seen, per kind. A kind reading 0/0 was never sent by the client.
    s += "injected     : move " + Sent[0] + "/" + Seen[0] + "   left " + Sent[1] + "/" + Seen[1]
       + "   right " + Sent[2] + "/" + Seen[2] + "   middle " + Sent[3] + "/" + Seen[3] + NL;
    s += "               wheel " + Sent[4] + "/" + Seen[4] + "   hwheel " + Sent[5] + "/" + Seen[5]
       + "   x " + Sent[6] + "/" + Seen[6] + "   unknown " + Seen[7] + " (last " + _lastOther + ")" + NL;
    // The line above counts only flagged events. This one counts everything, so a kind
    // reading 0 there and climbing here is one arriving without LLMHF_INJECTED — which is
    // a different fault entirely from a client that never sends it.
    s += "raw (all)    : move " + Raw[0] + "   left " + Raw[1] + "   right " + Raw[2]
       + "   middle " + Raw[3] + NL;
    s += "               wheel " + Raw[4] + "   hwheel " + Raw[5] + "   x " + Raw[6]
       + "   unknown " + Raw[7] + "   (your own mouse is in here too)" + NL;
    s += "ring         : " + _marker + (_markerOn ? "   showing at " + _vx + "," + _vy : "   hidden")
       + "   moves " + RingMoves + NL;
    s += "blocked      : " + Blocked + "   last: " + _lastFail + NL;
    if (Blocked > 0) {
      s += "               by kind: left " + BlockedKind[1] + "   right " + BlockedKind[2]
         + "   middle " + BlockedKind[3] + "   wheel " + BlockedKind[4] + "   x " + BlockedKind[6] + NL;
    }
    s += "jump distance: ";
    for (int i = 0; i < Dist.Length; i++) {
      if (Dist[i] == 0) continue;
      s += (i == 10 ? "200+" : (i * 20) + "-" + (i * 20 + 19)) + ":" + Dist[i] + "  ";
    }
    s += NL + "               threshold " + TAP_DIST + "px   in the 70-160 band: "
       + NearCount + " (last " + _nearMiss + ")" + NL;
    s += "last mapping : " + _lastMap + NL;
    s += "recent buttons, oldest first:" + NL;
    for (int i = 0; i < _recent.Length; i++) {
      string line = _recent[(_recentAt + i) % _recent.Length];
      if (line != null) s += "  " + line + NL;
    }
    return s;
  }

  public static int Run() {
    // Before any coordinate is read. A DPI-unaware process is handed virtualised
    // rectangles, which would put every mapping out by the display's scale factor —
    // silently, and only on the machines that scale their display.
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
    catch { try { SetProcessDPIAware(); } catch {} }

    _t0 = GetTickCount();
    _fn = new HookProc(Callback);
    _hook = SetWindowsHookExW(WH_MOUSE_LL, _fn, IntPtr.Zero, 0);
    if (_hook == IntPtr.Zero) {
      Console.WriteLine("{\\"error\\":\\"hook\\",\\"code\\":" + Marshal.GetLastWin32Error() + "}");
      return 1;
    }
    Console.WriteLine("{\\"ready\\":true}");
    Console.Out.Flush();

    /*
     * Everything that is not the pump runs here, on its own thread. Nothing on this thread
     * may ever be moved back into the loop below — see the note on Geom above.
     */
    _pumpThread = GetCurrentThreadId();

    /*
     * The watchdog, and it is the only exit path that cannot fail.
     *
     * The other two are checks: the worker tests the parent every 100ms, and the pump
     * tests it on a 500ms thread timer. Both are correct and both were measured working —
     * a parent killed in a test had this process gone in 243ms. Both also share an
     * assumption: that some thread is still going round its loop. A process holding a
     * system-wide low-level mouse hook is the one place that assumption must not be made.
     * It happened: a session outlived its launcher by half an hour, wrote no state file
     * (so the worker was gone) and did not answer the timer either, and the only way out
     * was a UAC prompt, because the whole chain had inherited administrator from the
     * user's own Lossless Scaling. Meanwhile every mouse event on the machine was paying
     * LowLevelHooksTimeout to step over a hook nobody was serving.
     *
     * This thread does not loop, poll, allocate or format. It blocks in the kernel on the
     * parent's handle and is woken by the parent's death itself. There is no state it can
     * be wedged by, and nothing to throw once the wait has been entered.
     */
    System.Threading.Thread watchdog = new System.Threading.Thread(delegate() {
      try {
        if (ParentPid <= 0) return;
        IntPtr ph = OpenProcess(SYNCHRONIZE, false, (uint)ParentPid);
        // Cannot even open it: it is already gone, or out of reach, and this process must
        // not outlive it on a guess.
        if (ph != IntPtr.Zero) WaitForSingleObject(ph, 0xFFFFFFFF);
      } catch { }
      // Unhook first, so the hook is gone before anything else is attempted.
      try { if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook); } catch { }
      /*
       * TerminateProcess rather than Environment.Exit, and the difference was measured:
       * Exit runs finalisers and the host's own shutdown and took 2.2 seconds, against
       * 243ms for the ordinary unwind it was meant to beat. There is nothing in this
       * process worth shutting down tidily — no unsaved state, no file half written that
       * matters — and everything worth ending at once, because until it ends every mouse
       * event on the machine still goes past its hook. The exit code is read by nobody:
       * the parent it would report to is what just died.
       */
      try { TerminateProcess(GetCurrentProcess(), 3); } catch { }
      Environment.Exit(3);
    });
    watchdog.IsBackground = true;
    watchdog.Start();

    System.Threading.Thread worker = new System.Threading.Thread(delegate() {
      int lastMapped = -1, lastBlocked = 0;
      while (!_stopping) {
        /*
         * Every statement in this loop is inside a catch, and that is not defensive habit.
         * The version without it wrote to stdout unguarded; when the parent was killed the
         * pipe broke, the write threw, this thread died, and with it went both the state
         * file and the parent check — leaving a process holding a system-wide mouse hook
         * that nothing could talk it out of. The launcher had been started elevated, so it
         * could not even be killed without a UAC prompt.
         */
        try { Refresh(); } catch (Exception ex) { _why = "refresh threw: " + ex.Message; }
        // The ring is put away by anything that ends the mapping, not only by an event
        // that declined to map — the last event before a game closes is one that mapped.
        try { Geom now = _geom; if (now == null || !now.Active) _markerOn = false; } catch { }
        try { if (StatePath.Length > 0) System.IO.File.WriteAllText(StatePath, StateText()); } catch {}
        // Written whole each time, oldest first. A ring that has not wrapped has nulls in
        // it, which are skipped rather than printed as blank lines.
        try {
          if (TracePath.Length > 0 && _traceSeq > 0) {
            System.Text.StringBuilder tb = new System.Text.StringBuilder();
            int at = _traceAt;
            for (int i = 0; i < _trace.Length; i++) {
              string line = _trace[(at + i) % _trace.Length];
              if (line != null) tb.Append(line).Append(NL);
            }
            System.IO.File.WriteAllText(TracePath, tb.ToString());
          }
        } catch {}
        try {
          if (Mapped != lastMapped) {
            lastMapped = Mapped;
            Console.WriteLine("{\\"mapped\\":" + Mapped + "}");
            Console.Out.Flush();
          }
          // Reported separately, and only when it happens. A press the system refused to
          // re-inject is destroyed rather than misplaced, and nothing else on screen would
          // ever say so.
          if (Blocked != lastBlocked) {
            lastBlocked = Blocked;
            Console.WriteLine("{\\"blocked\\":" + Blocked + "}");
            Console.Out.Flush();
          }
        } catch { lastMapped = Mapped; lastBlocked = Blocked; }
        // Checked briskly: closing the launcher is the documented way out of a mapping that
        // has gone wrong, and how long it takes is how long somebody sits there unable to
        // use their mouse.
        for (int i = 0; i < 6 && !_stopping; i++) {
          System.Threading.Thread.Sleep(100);
          // Guarded like everything else in this loop. An unguarded call here would kill
          // the worker thread, and with it the state file and this very check.
          try { if (!ParentAlive()) { _stopping = true; break; } } catch { }
          // The other documented way out, checked at the rate the promise is written in
          // rather than at the sweep's. See StillScaling.
          try { if (!StillScaling()) GoInert("output window gone"); } catch { }
        }
      }
      // WM_NULL, purely to wake GetMessage so the pump can notice and unwind.
      PostThreadMessageW(_pumpThread, 0, IntPtr.Zero, IntPtr.Zero);
    });
    worker.IsBackground = true;
    worker.Start();

    // The ring, on a third thread of its own for the reason given above it: neither the
    // pump nor the worker may own a window this one moves 125 times a second.
    System.Threading.Thread ring = new System.Threading.Thread(new System.Threading.ThreadStart(MarkerLoop));
    ring.IsBackground = true;
    ring.Start();

    try {
      /*
       * A blocking GetMessage, not PeekMessage on a timer. The system dispatches a
       * low-level hook by posting to this thread's queue, so the callback runs from inside
       * this call — which means the pointer's latency is however long this thread takes to
       * get back here. Sleeping 4ms between polls put a 4ms floor under every mouse event
       * on the machine; doing real work here froze it outright.
       */
      /*
       * The parent check lives here too, on a thread timer, and the redundancy is the
       * point: this is the thread that cannot be doing anything else, so as long as the
       * pump is running the process can still be told to leave. The worker thread dying
       * must never again be able to strand a global mouse hook.
       */
      SetTimer(IntPtr.Zero, IntPtr.Zero, 500, IntPtr.Zero);
      MSG msg;
      while (!_stopping && GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) {
        if (msg.message == 0x0113 && !ParentAlive()) break;   // WM_TIMER
      }
    } finally {
      _stopping = true;
      UnhookWindowsHookEx(_hook);
      _hook = IntPtr.Zero;
    }
    return 0;
  }
}
'@

[SakuraPointer]::GameDir = $env:SAKURA_PM_DIR
[SakuraPointer]::UpscalerExe = $env:SAKURA_PM_EXE
[SakuraPointer]::Fit = [int]$env:SAKURA_PM_FIT
[SakuraPointer]::Factor = [double]$env:SAKURA_PM_FACTOR
[SakuraPointer]::ParentPid = [int]$env:SAKURA_PM_PPID
[SakuraPointer]::StatePath = $env:SAKURA_PM_STATE
if ($env:SAKURA_PM_TRACE) { [SakuraPointer]::TracePath = $env:SAKURA_PM_TRACE }
exit [SakuraPointer]::Run()
`

/**
 * Lay the script down where it can be run from, and hand back its path.
 *
 * Under the app's own data directory rather than the temp folder, which is not tidiness:
 * a PowerShell script appearing in `%TEMP%` and immediately installing a system-wide mouse
 * hook is a shape scanners are right to be suspicious of, and this one has a home.
 *
 * Rewritten only when the contents differ, so the file on disk stays put across launches.
 * Returns null when it cannot be written — a hook that cannot start leaves the user exactly
 * where they were before turning this on, which is a state the rest of the program already
 * handles.
 */
function ensureScript(): string | null {
  try {
    const dir = path.join(app.getPath('userData'), 'pointer')
    const file = path.join(dir, 'pointer-map.ps1')
    // The BOM is load-bearing: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
    const text = `\ufeff${POINTER_SCRIPT}`
    let current: string | null = null
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch {
      current = null
    }
    if (current !== text) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
    }
    return file
  } catch {
    return null
  }
}

/** What the settings page reads. */
export function pointerMapState(): PointerMapState {
  return { ...state }
}

/**
 * Whether the running mapper is still aimed at a game that is playing.
 *
 * True when nothing is running, because there is then nothing aimed anywhere and nothing
 * to stop. The caller uses this to notice the one case a check on "is anything scaled
 * still playing" cannot see: two scaled games, the second one closed, the hook left
 * pointed at a folder with no windows in it.
 */
export function pointerMapAimedAt(playing: string[]): boolean {
  if (child === null || aimedAt === null) return true
  return playing.includes(aimedAt)
}

/**
 * Start mapping, replacing anything already running.
 *
 * Silently does nothing off Windows, so the caller does not have to ask.
 */
export function startPointerMap(opts: PointerMapOptions): void {
  if (process.platform !== 'win32') return
  stopPointerMap()

  const file = ensureScript()
  if (file === null) return

  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SAKURA_PM_DIR: opts.gameDir,
        SAKURA_PM_EXE: opts.upscalerExe,
        SAKURA_PM_FIT: String(FIT_CODE[opts.fit]),
        SAKURA_PM_FACTOR: String(opts.factor),
        SAKURA_PM_PPID: String(process.pid),
        SAKURA_PM_STATE: path.join(path.dirname(file), 'state.txt'),
        // Beside the state file, and for now unconditional: the classification is being
        // diagnosed from real sessions, and a summary written after the fact has already
        // been shown to lose the one thing that mattered.
        SAKURA_PM_TRACE: path.join(path.dirname(file), 'trace.txt')
      }
    }
  )
  child = proc
  aimedAt = opts.gameId
  state = { running: true, active: false, mapped: 0, blocked: 0 }

  // Nothing here is worth a throw: a hook that failed to install means taps are not mapped,
  // which is exactly the state the user was in before turning this on.
  const started = setTimeout(() => {
    if (child === proc) stopPointerMap()
  }, START_TIMEOUT_MS)

  // Add-Type failing to compile is the one failure that produces nothing on stdout, and
  // it is the one worth being able to see. Kept to a single line; this is not a log.
  let firstError = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    if (firstError === '') firstError = chunk.trim().split(/\r?\n/)[0] ?? ''
  })

  let buffer = ''
  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (text === '') continue
      try {
        const row = JSON.parse(text) as Record<string, unknown>
        if (row.ready === true) clearTimeout(started)
        if (typeof row.active === 'boolean') state = { ...state, active: row.active }
        if (typeof row.mapped === 'number') state = { ...state, mapped: row.mapped }
        if (typeof row.blocked === 'number') state = { ...state, blocked: row.blocked }
        /*
         * Kept, not merely acknowledged. `SetWindowsHookExW` failing prints this on
         * **stdout** and exits with nothing on stderr, so a version that only cleared the
         * timer left `error` undefined — and the settings page, finding no error and
         * nothing running, said "it starts with the next game". That is the exact
         * confusion `pointerMapFailed` exists to prevent, on the one path where the
         * feature is permanently broken rather than merely waiting.
         */
        if (typeof row.error === 'string') {
          clearTimeout(started)
          firstError = firstError || `hook: ${row.error}`
        }
      } catch {
        // A line that is not JSON is PowerShell talking to itself. Not our business.
      }
    }
  })

  const done = (): void => {
    clearTimeout(started)
    if (child === proc) {
      child = null
      state = {
      running: false,
      active: false,
      mapped: state.mapped,
      blocked: state.blocked,
      error: firstError || undefined
    }
    }
  }
  proc.on('exit', done)
  proc.on('error', done)
}

/**
 * Stop mapping.
 *
 * Killed outright rather than asked politely: it holds a system-wide hook and no state
 * worth saving, and the one thing that must not happen is it outliving the session that
 * started it. `taskkill /T` because the hook lives in the PowerShell we spawned and there
 * is nothing else in the tree to be careful of.
 */
export function stopPointerMap(): void {
  const proc = child
  child = null
  aimedAt = null
  state = { running: false, active: false, mapped: 0, blocked: 0 }
  if (!proc || proc.exitCode !== null) return
  try {
    proc.kill()
  } catch {
    // Already gone.
  }
}
