import type { Atlas } from "./build.js";

/**
 * Scene maps (art/maps/*.json): layers of character rows and a legend
 * character → tileset tile (`<tileset>.<name>`). "Spots" are tile positions
 * where the trainer, dogs and props go.
 */
export interface SceneMap {
  name: string;
  tileSize: number;
  tileset: string;
  width: number;
  height: number;
  legend: Record<string, string | null>;
  layers: { name: string; rows: string[] }[];
  spots: {
    trainer: [number, number];
    companion: [number, number];
    bed?: [number, number];
    puppies: [number, number][];
    props?: Record<string, [number, number]>;
    /** Agility: position of each obstacle, in course order. */
    obstacles?: [number, number][];
  };
}

export function validateMap(map: SceneMap, tiles: Atlas, sprites: Atlas): string[] {
  const errors: string[] = [];
  if (map.tileSize !== tiles.grid) errors.push(`tileSize ${map.tileSize} ≠ grid ${tiles.grid}`);
  for (const [ch, name] of Object.entries(map.legend)) {
    if (name !== null && !tiles.sprites[`${map.tileset}.${name}`]) errors.push(`legend "${ch}": tile ${map.tileset}.${name} does not exist`);
  }
  for (const layer of map.layers) {
    if (layer.rows.length !== map.height) errors.push(`layer ${layer.name}: ${layer.rows.length} rows (expected ${map.height})`);
    layer.rows.forEach((row, y) => {
      if (row.length !== map.width) errors.push(`layer ${layer.name}, row ${y}: ${row.length} columns (expected ${map.width})`);
      for (const ch of row) if (!(ch in map.legend)) errors.push(`layer ${layer.name}, row ${y}: character "${ch}" has no legend`);
    });
  }
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x < map.width && y < map.height;
  const spots: [string, [number, number]][] = [
    ["trainer", map.spots.trainer],
    ["companion", map.spots.companion],
    ...(map.spots.bed ? [["bed", map.spots.bed] as [string, [number, number]]] : []),
    ...map.spots.puppies.map((p, i) => [`puppies[${i}]`, p] as [string, [number, number]]),
    ...Object.entries(map.spots.props ?? {}).map(([k, p]) => [`props.${k}`, p] as [string, [number, number]]),
    ...(map.spots.obstacles ?? []).map((p, i) => [`obstacles[${i}]`, p] as [string, [number, number]]),
  ];
  for (const [name, pos] of spots) if (!inside(pos)) errors.push(`spot ${name} is outside the map`);
  for (const name of Object.keys(map.spots.props ?? {})) {
    if (!sprites.sprites[`prop.${name}`]) errors.push(`spot props.${name}: sprite prop.${name} does not exist`);
  }
  return errors;
}
