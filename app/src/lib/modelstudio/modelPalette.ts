/** Default viewer colors. Custom wall textures and frame finish choices remain authoritative. */
export const MODEL_PALETTE = {
  wall: 0xeadcc8,
  wallSide: 0xd2bea5,
  floorLid: 0xd8cbb8,
  roofDeck: 0x65747b,
  roofParapet: 0x526168,
  defaultGlass: 0xb8c5c3,
} as const;

/** A saved finish texture must not be recolored by the default shell palette. */
export const wallTintForTexture = (url: string): number =>
  url === "/modelstudio/textures/wall-white.png" ? MODEL_PALETTE.wall : 0xffffff;
