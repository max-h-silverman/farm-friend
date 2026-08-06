import {
  ISLAND_VIEWBOX,
  projectToIsland,
} from "@farm-friend/core/island-projection";
import {
  ISLAND_HIGHWAY,
  ISLAND_PLACES,
  ISLAND_ROADS,
  ISLAND_SHORELINE,
  ISLAND_WOODS,
  svgLine,
  svgRing,
} from "../lib/island-geometry";

// F-043 — the island artwork, drawn rather than tiled.
//
// This file is JSX only. Every coordinate it draws lives in `lib/island-geometry.ts`, where
// the test suite can reach it — see the note there for why that split is load-bearing.

/**
 * The island artwork — water, land, highway, place labels.
 *
 * Purely decorative in the accessibility sense: it is `aria-hidden` and carries no
 * information a customer cannot get from the stand list beside it. The list is the accessible
 * surface; this orients someone who can see it. That is why no stand's status is encoded here
 * in colour alone — the card carries the words.
 */
export function IslandArtwork() {
  return (
    <g aria-hidden="true">
      <rect
        x={0}
        y={0}
        width={ISLAND_VIEWBOX.width}
        height={ISLAND_VIEWBOX.height}
        className="island-water"
      />
      <path d={svgRing(ISLAND_SHORELINE)} className="island-land" />
      {/*
      The wooded parks, drawn BETWEEN the land and the road: they are texture on the island,
      and a road running under a forest block would read as a tunnel.
      */}
      {ISLAND_WOODS.map((wood) => (
        <path key={wood.name} d={svgRing(wood.ring)} className="island-wood" />
      ))}
      {/*
      The secondary arteries go UNDER the highway, and are drawn thinner and lighter (F-070).
      The spine has to keep reading as the spine: if every road carries the same weight, the
      drawing stops orienting anyone and becomes the street map this deliberately is not.
      */}
      {ISLAND_ROADS.map((road, index) => (
        <path
          // Westside Highway is two separate chains, so the name alone is not unique.
          key={`${road.name}-${index}`}
          d={svgLine(road.line)}
          className="island-road-minor"
        />
      ))}
      <path d={svgLine(ISLAND_HIGHWAY)} className="island-road" />
      {ISLAND_PLACES.map((place) => {
        const { x, y } = projectToIsland({
          latitude: place.at[0],
          longitude: place.at[1],
        });
        const [dx, dy] = place.nudge ?? [0, 0];
        return (
          <text
            key={place.name}
            x={x + dx}
            y={y + dy}
            className="island-place"
          >
            {place.name}
          </text>
        );
      })}
    </g>
  );
}

