import L from "leaflet";
import "leaflet/dist/leaflet.css";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";

// Vite-bundled marker icons; the default Leaflet icon URLs assume a CDN layout
// that doesn't match the bundler output.
L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });

export { L };
