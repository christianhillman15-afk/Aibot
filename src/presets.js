// Preset library — the "Higgsfield feel": pick a cinematic camera motion and a
// look instead of writing a long prompt. These are pure prompt fragments, so
// they cost nothing extra — they just steer the video model toward a
// professional, intentional result. The UI appends the selected fragments to
// the user's prompt. Edit freely; add your own signature moves.

export const CAMERA_MOTIONS = [
  { id: "none", label: "No preset", prompt: "" },
  { id: "crash_zoom_in", label: "Crash Zoom In", prompt: "sudden aggressive crash zoom in, rapid punch-in on the subject" },
  { id: "crash_zoom_out", label: "Crash Zoom Out", prompt: "fast crash zoom out revealing the wider scene" },
  { id: "bullet_time", label: "Bullet Time", prompt: "bullet-time frozen moment, camera orbiting around the subject, dramatic slow motion" },
  { id: "fpv_drone", label: "FPV Drone", prompt: "fast FPV drone fly-through, dynamic sweeping aerial motion" },
  { id: "orbit_360", label: "360° Orbit", prompt: "smooth cinematic 360 degree orbit around the subject" },
  { id: "dolly_zoom", label: "Dolly Zoom", prompt: "vertigo dolly zoom, background compressing behind the subject" },
  { id: "crane_up", label: "Crane Up", prompt: "crane shot rising upward to reveal the full scene" },
  { id: "slow_push", label: "Slow Push In", prompt: "slow cinematic push in, subtle dolly toward the subject" },
  { id: "whip_pan", label: "Whip Pan", prompt: "fast whip pan with motion blur" },
  { id: "handheld", label: "Handheld", prompt: "handheld documentary camera with natural shake and energy" },
  { id: "low_hero", label: "Low-Angle Hero", prompt: "dramatic low-angle hero shot looking up at the subject" },
  { id: "action_chase", label: "Action Chase", prompt: "high-speed action chase, heavy motion blur, kinetic energy" },
  { id: "explosion", label: "Explosion", prompt: "dramatic explosion behind the subject, debris and shockwave, epic" },
  { id: "snorricam", label: "Snorricam", prompt: "snorricam rig, the subject stays fixed in frame while the world spins around them" },
];

export const STYLES = [
  { id: "none", label: "No style", prompt: "" },
  { id: "cinematic", label: "Cinematic", prompt: "cinematic film still, shallow depth of field, dramatic volumetric lighting, 35mm, color graded, highly detailed" },
  { id: "photoreal", label: "Photorealistic", prompt: "photorealistic, natural lighting, ultra detailed, lifelike" },
  { id: "product_ad", label: "Product Ad", prompt: "clean commercial product shot, studio lighting, glossy reflections, premium advertising look" },
  { id: "cyberpunk", label: "Cyberpunk", prompt: "cyberpunk neon city, rain, reflective surfaces, blade-runner aesthetic, moody" },
  { id: "anime", label: "Anime", prompt: "anime style, cel shaded, vibrant colors, expressive" },
  { id: "vintage", label: "Vintage Film", prompt: "vintage 16mm film grain, warm retro color, nostalgic" },
  { id: "pixar3d", label: "Stylized 3D", prompt: "stylized 3D animation, soft global illumination, playful, pixar-like" },
  { id: "noir", label: "Film Noir", prompt: "black and white film noir, high contrast, dramatic shadows" },
  { id: "documentary", label: "Documentary", prompt: "natural documentary look, realistic handheld framing, candid" },
];

export function presetPayload() {
  return { cameraMotions: CAMERA_MOTIONS, styles: STYLES };
}
