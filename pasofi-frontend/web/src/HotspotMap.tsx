import { useEffect, useRef, useState } from 'react';
import { divIcon, latLngBounds, map, marker, tileLayer, type LatLngTuple } from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Public pins supplied by the site owner. These identify places, independent of sales eligibility.
const hotspots: { name: string; position: LatLngTuple; url: string }[] = [
  { name: 'Kuwadzana', position: [-17.8322389, 30.9223984], url: 'https://maps.app.goo.gl/K6o1SSb8gzUtYBQr5' },
  { name: 'Lawfield Farm', position: [-17.7610375, 31.4316094], url: 'https://maps.app.goo.gl/zmJ7f3DXCnHj58T86' },
];

export default function HotspotMap() {
  const container = useRef<HTMLDivElement>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  useEffect(() => {
    if (!container.current) return;

    const hotspotMap = map(container.current, { maxZoom: 19, scrollWheelZoom: false });
    hotspotMap.attributionControl.setPrefix(false);
    const tiles = tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      referrerPolicy: 'strict-origin',
    });
    let hasLoadedTile = false;
    tiles.on('tileload', () => {
      hasLoadedTile = true;
      setTilesUnavailable(false);
    });
    tiles.on('load', () => setTilesUnavailable(!hasLoadedTile));
    tiles.addTo(hotspotMap);

    const pin = divIcon({ className: 'pasofi-map-marker', iconSize: [40, 40], iconAnchor: [20, 37], popupAnchor: [0, -34] });
    for (const hotspot of hotspots) {
      const popup = document.createElement('div');
      popup.className = 'pasofi-map-popup';
      const name = document.createElement('strong');
      name.textContent = hotspot.name;
      const link = document.createElement('a');
      link.href = hotspot.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open in Google Maps';
      popup.append(name, link);
      const location = marker(hotspot.position, { icon: pin, title: hotspot.name });
      location.addTo(hotspotMap).bindPopup(popup);
      location.getElement()?.setAttribute('aria-label', hotspot.name);
    }
    hotspotMap.fitBounds(latLngBounds(hotspots.map(hotspot => hotspot.position)), { padding: [40, 40], maxZoom: 16 });

    return () => {
      tiles.off();
      hotspotMap.remove();
    };
  }, []);

  return <>
    <div ref={container} className="pasofi-map-canvas" role="region" aria-label="Hotspot map"/>
    {tilesUnavailable && <p className="pasofi-map-tile-status" role="status">Map background is unavailable. Select a pin to open its location.</p>}
  </>;
}
