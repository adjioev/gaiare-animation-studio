// Hand-tuned prompt templates that work with `wan-video/wan-2.2-i2v-fast`.
// Derived from the q14 playbook (see `gaiare-next-server/docs/animated-explainer-pipeline.md`).
// When AI starts authoring prompts it should pull from these — humans
// still tweak before generation.

export const PROMPT_TEMPLATES = {
  singleActorTurnExit: `The {{COLOR}} {{VEHICLE}} in the {{START_POSITION}} turns {{TURN_DIRECTION}} through the intersection, following the yellow curved arrow on the road. The {{VEHICLE}} continues driving {{TURN_DIRECTION}}ward, growing slightly larger as it approaches the camera, and exits the frame at the {{EXIT_EDGE}} edge.

By the end of the clip, the {{COLOR}} {{VEHICLE}} is completely off-screen — no longer visible in the frame.

{{OTHER_ACTORS_STATIONARY_BLOCK}}

Static camera, no zoom, no pan. Photorealistic.`,

  twoActorsOppositeDirections: `Two vehicles drive in opposite directions on a city street at an intersection.

The {{ACTOR_A_COLOR}} {{ACTOR_A_VEHICLE}} in the {{ACTOR_A_POSITION}} continues driving straight toward the camera, moving down the road and exiting the frame at the bottom edge.

The {{ACTOR_B_COLOR}} {{ACTOR_B_VEHICLE}} {{ACTOR_B_START_STATE}} drives forward away from the camera, moving straight through the intersection into the distance, becoming smaller as it advances.

Both vehicles do not interact — they pass each other moving in opposite directions on adjacent lanes.

Static camera, no zoom, no pan. Photorealistic.`,

  slowStartPreamble: `The {{COLOR}} {{VEHICLE}} {{POSITION_DESCRIPTION}} is initially STOPPED at rest. At the very start of the clip, the {{VEHICLE}} is completely stationary — its wheels are not moving. The {{VEHICLE}} then slowly begins to roll forward, gradually accelerating from a standstill to normal driving speed over the first 2 seconds. After that, it continues at steady speed.`,
} as const;

// q14 known-good prompts as the seed for the prompt history.
export const Q14_PRESETS = {
  clip1: `The red sedan in the upper background turns left through the intersection, following the yellow curved arrow on the road. The car continues driving leftward, growing slightly larger as it approaches the camera, and exits the frame at the bottom-left edge.

By the end of the clip, the red sedan is completely off-screen — no longer visible in the frame.

The yellow van in the foreground does NOT move. The van remains stationary throughout.

Static camera, no zoom, no pan. Photorealistic.`,

  clip2: `Two vehicles drive in opposite directions on a city street at an intersection.

The red sedan in the center-left continues driving straight toward the camera, moving down the road and exiting the frame at the bottom edge. By the end of the clip, the red sedan is completely off-screen.

The yellow van in the foreground is initially STOPPED at rest. At the very start of the clip, the van is completely stationary — its wheels are not moving. The van then slowly begins to roll forward, gradually accelerating from a standstill to normal driving speed, moving straight away from the camera through the intersection into the distance.

Static camera, no zoom, no pan. Photorealistic.`,
};
