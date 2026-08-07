import farmMapLogo from "../../../../assets/viga-farm-map.png";

/**
 * Immediate route fallback while the current public listings are read on the server.
 *
 * **Scoped to the `(map)` route group deliberately.** At the app root this wrapped EVERY route,
 * and a Suspense boundary commits an HTTP 200 as soon as the shell streams — which made the
 * F-079 secret door answer 200 while rendering 404 markup, since `notFound()` runs after the
 * status is already sent. Proven by removing this file and watching the same request become a
 * real 404 against the standalone server. The group keeps the spinner where it belongs and off
 * the routes whose status has to be their own.
 */
export default function MapLoading() {
  return (
    <main className="map-loading" role="status" aria-live="polite">
      <img src={farmMapLogo.src} alt="" aria-hidden="true" />
      <span className="map-loading-spinner" aria-hidden="true" />
      <p>Loading farm map…</p>
    </main>
  );
}
