// Turns the editor project into ffmpeg arguments. `node export.js` runs a self-check.
const PRESETS = {
  youtube: { '1080p': [1920, 1080], '2k': [2560, 1440], '4k': [3840, 2160] },
  tiktok: { '1080p': [1080, 1920], '2k': [1440, 2560], '4k': [2160, 3840] },
};
const FLASH = 0.25, FADE = 0.2; // seconds, keep in sync with renderer.js

// atempo only takes 0.5..2 per instance on older ffmpeg, so chain it
function atempo(speed) {
  const parts = [];
  while (speed < 0.5) { parts.push('atempo=0.5'); speed /= 0.5; }
  while (speed > 2) { parts.push('atempo=2'); speed /= 2; }
  parts.push(`atempo=${speed}`);
  return parts.join(',');
}

function buildArgs({ clips, music, gameDb = 0, format, res, fps = 60 }, outPath, gpu = true) {
  const [W, H] = PRESETS[format][res];
  const args = ['-y'], f = [];
  const durs = clips.map(c => (c.out - c.in) / c.speed);
  const total = durs.reduce((a, b) => a + b, 0);

  clips.forEach((c, i) => {
    const d = durs[i];
    if (gpu) args.push('-hwaccel', 'cuda');
    args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', c.path);
    // scale to fill + center crop, so 16:9 gameplay becomes 9:16 for TikTok
    let v = `[${i}:v]setpts=(PTS-STARTPTS)/${c.speed},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}`;
    if (c.transition === 'flash') v += `,fade=t=in:st=0:d=${FLASH}:color=white`;
    if (c.transition === 'fade') v += `,fade=t=in:st=0:d=${FADE}`;
    if (clips[i + 1]?.transition === 'fade') v += `,fade=t=out:st=${Math.max(0, d - FADE).toFixed(3)}:d=${FADE}`;
    f.push(`${v},format=yuv420p[v${i}]`);
    const a = c.hasAudio
      ? `[${i}:a]asetpts=PTS-STARTPTS,${atempo(c.speed)},volume=${c.db + gameDb}dB`
      : 'anullsrc=r=48000:cl=stereo';
    f.push(`${a},aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end=${d.toFixed(3)}[a${i}]`);
  });
  f.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[v][ca]`);

  let aout = '[ca]';
  if (music) {
    args.push('-ss', music.offset.toFixed(3), '-i', music.path);
    let m = `[${clips.length}:a]asetpts=PTS-STARTPTS,volume=${music.db}dB,aformat=sample_rates=48000:channel_layouts=stereo,atrim=end=${total.toFixed(3)}`;
    if (music.fade) m += `,afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2`;
    f.push(`${m}[mu]`, '[ca][mu]amix=inputs=2:duration=first:normalize=0[aout]');
    aout = '[aout]';
  }

  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', aout,
    // NVENC p5 + cq 19 ~= x264 crf 17 quality, many times faster; x264 for PCs without an NVIDIA GPU
    ...(gpu ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17']),
    '-c:a', 'aac', '-b:a', '320k',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outPath);
  return { args, total };
}

module.exports = { buildArgs, PRESETS };

if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(atempo(1), 'atempo=1');
  assert.strictEqual(atempo(0.25), 'atempo=0.5,atempo=0.5');
  assert.strictEqual(atempo(3), 'atempo=2,atempo=1.5');
  const clip = { path: 'a.mp4', in: 2, out: 6, speed: 2, db: -3, hasAudio: true, transition: 'none' };
  const { args, total } = buildArgs({
    clips: [clip, { ...clip, hasAudio: false, transition: 'fade' }],
    music: { path: 'm.mp3', offset: 1, db: 4, fade: true }, gameDb: -2, format: 'tiktok', res: '4k',
  }, 'out.mp4');
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.strictEqual(total, 4);
  assert.ok(fc.includes('crop=2160:3840'));
  assert.ok(fc.includes('volume=-5dB') && fc.includes('volume=4dB'), 'clip db + game master, music separate');
  assert.ok(fc.includes('fade=t=out:st=1.800'), 'clip before a fade fades out');
  assert.ok(fc.includes('anullsrc'), 'silent clip gets generated audio');
  assert.ok(args.includes('h264_nvenc') && args.includes('cuda'));
  const cpu = buildArgs({ clips: [clip], music: null, format: 'youtube', res: '1080p' }, 'out.mp4', false).args;
  assert.ok(cpu.includes('libx264') && !cpu.includes('cuda') && !cpu.includes('h264_nvenc'), 'CPU fallback has no GPU flags');
  console.log('export.js ok');
}
