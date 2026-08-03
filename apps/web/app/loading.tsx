import farmMapLogo from "../../../assets/viga-farm-map.png";

/** Immediate route fallback while the current public listings are read on the server. */
export default function MapLoading() {
  return (
    <main className="map-loading" role="status" aria-live="polite">
      <img src={farmMapLogo.src} alt="" aria-hidden="true" />
      <span className="map-loading-spinner" aria-hidden="true" />
      <p>Loading farm map…</p>
    </main>
  );
}
