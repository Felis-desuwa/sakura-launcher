/**
 * The whole window, drawn with a five-petal blossom and a few CSS animations.
 * No external font, image or script — anything that has to be fetched is a chance for
 * the splash to appear after the thing it was meant to cover.
 */
export function splashHtml(): string {
  const petal =
    'M 0,-8 C -14,-14 -20,-32 -11,-41 C -6,-46 -2,-44 0,-36 ' +
    'C 2,-44 6,-46 11,-41 C 20,-32 14,-14 0,-8 Z'
  const petals = [0, 72, 144, 216, 288]
    .map((deg) => `<path d="${petal}" transform="rotate(${deg})"/>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%; overflow: hidden; background: transparent;
    font-family: 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif;
    -webkit-user-select: none; cursor: default;
  }
  .card {
    position: absolute; inset: 10px; border-radius: 18px; overflow: hidden;
    background: linear-gradient(155deg, #fffafc 0%, #ffeef5 55%, #ffe1ed 100%);
    border: 1px solid #ffd3e3;
    box-shadow: 0 14px 38px rgba(203, 96, 140, 0.30);
    -webkit-app-region: drag;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  /* Falling petals, purely decorative, behind everything else. */
  .petals i {
    position: absolute; top: -14px; width: 9px; height: 9px;
    background: linear-gradient(160deg, #ffd7e7, #ff9cc3);
    border-radius: 50% 0 50% 50%; opacity: 0;
    animation: fall linear infinite;
  }
  .petals i:nth-child(1) { left: 12%; animation-duration: 5.4s; animation-delay: -0.4s; }
  .petals i:nth-child(2) { left: 33%; animation-duration: 7.1s; animation-delay: -3.2s; }
  .petals i:nth-child(3) { left: 56%; animation-duration: 6.2s; animation-delay: -1.7s; }
  .petals i:nth-child(4) { left: 74%; animation-duration: 8.0s; animation-delay: -5.1s; }
  .petals i:nth-child(5) { left: 89%; animation-duration: 6.7s; animation-delay: -2.6s; }
  @keyframes fall {
    0%   { transform: translate(0, 0) rotate(0deg); opacity: 0; }
    12%  { opacity: 0.8; }
    100% { transform: translate(-26px, 230px) rotate(340deg); opacity: 0; }
  }
  .blossom {
    width: 62px; height: 62px; position: relative;
    animation: breathe 3.4s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1) rotate(-5deg); }
    50%      { transform: scale(1.07) rotate(5deg); }
  }
  .title {
    margin-top: 14px; font-size: 18px; font-weight: 600;
    letter-spacing: 0.16em; color: #8f4364;
  }
  .stage {
    margin-top: 7px; font-size: 12.5px; letter-spacing: 0.05em; color: #bb849e;
    transition: opacity 0.2s ease;
  }
  /* Indeterminate: there is no honest percentage to show, only that work is happening. */
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: rgba(255, 190, 214, 0.30); overflow: hidden;
  }
  .bar span {
    position: absolute; top: 0; bottom: 0; width: 38%;
    background: linear-gradient(90deg, transparent, #ffa8c8, #ff6fa5, #ffa8c8, transparent);
    animation: sweep 1.6s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  @keyframes sweep { 0% { left: -40%; } 100% { left: 100%; } }
</style></head>
<body>
  <div class="card">
    <div class="petals"><i></i><i></i><i></i><i></i><i></i></div>
    <svg class="blossom" viewBox="-50 -50 100 100">
      <defs>
        <radialGradient id="pg" cx="50%" cy="78%" r="82%">
          <stop offset="0%" stop-color="#fff4f8"/>
          <stop offset="58%" stop-color="#ffc6db"/>
          <stop offset="100%" stop-color="#ff8fb8"/>
        </radialGradient>
      </defs>
      <g fill="url(#pg)" stroke="#ff9dc0" stroke-width="1.1">${petals}</g>
      <circle r="4.6" fill="#ffd98a"/>
      <g fill="#f5b44e">
        <circle cx="0" cy="-9" r="1.5"/><circle cx="8" cy="-3" r="1.5"/>
        <circle cx="5" cy="7" r="1.5"/><circle cx="-5" cy="7" r="1.5"/>
        <circle cx="-8" cy="-3" r="1.5"/>
      </g>
    </svg>
    <div class="title">Sakura Launcher</div>
    <div class="stage" id="stage">正在准备…</div>
    <div class="bar"><span></span></div>
  </div>
</body></html>`
}
