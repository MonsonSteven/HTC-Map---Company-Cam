<?php
/**
 * Plugin Name: HTC Projects Map
 * Description: Displays a past projects map from a GeoJSON feed (CompanyCam via webhook pipeline).
 * Version: 1.0.0
 * Author: HTC
 */

if (!defined('ABSPATH')) exit;

class HTC_Projects_Map {
  const VERSION = '1.0.0';

  public function __construct() {
    add_shortcode('htc_projects_map', [$this, 'shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'register_assets']);
  }

  public function register_assets() {
    // Leaflet from CDN
    wp_register_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_register_script('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);

    // Optional marker clustering (nice when you have lots of pins)
    wp_register_style('leaflet-markercluster', 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css', [], '1.5.3');
    wp_register_style('leaflet-markercluster-default', 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css', [], '1.5.3');
    wp_register_script('leaflet-markercluster', 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js', ['leaflet'], '1.5.3', true);
  }

  public function shortcode($atts) {
    $atts = shortcode_atts([
      'feed' => '',               // required: GeoJSON URL
      'height' => '520px',
      'center_lat' => '30.45',     // default-ish Gulf Coast
      'center_lng' => '-87.25',
      'zoom' => '9',
      'cluster' => '1',           // 1 = on, 0 = off
    ], $atts);

    if (empty($atts['feed'])) {
      return '<div style="padding:12px;border:1px solid #ddd;border-radius:8px;">HTC Projects Map: missing <code>feed</code> URL.</div>';
    }

    wp_enqueue_style('leaflet');
    wp_enqueue_script('leaflet');

    $use_cluster = ($atts['cluster'] === '1');
    if ($use_cluster) {
      wp_enqueue_style('leaflet-markercluster');
      wp_enqueue_style('leaflet-markercluster-default');
      wp_enqueue_script('leaflet-markercluster');
    }

    $map_id = 'htc_projects_map_' . wp_generate_uuid4();

    ob_start(); ?>
      <div id="<?php echo esc_attr($map_id); ?>" style="width:100%;height:<?php echo esc_attr($atts['height']); ?>;border-radius:16px;overflow:hidden;"></div>
      <script>
        (function(){
          const feedUrl = <?php echo wp_json_encode($atts['feed']); ?>;
          const center = [<?php echo floatval($atts['center_lat']); ?>, <?php echo floatval($atts['center_lng']); ?>];
          const zoom = <?php echo intval($atts['zoom']); ?>;
          const useCluster = <?php echo $use_cluster ? 'true' : 'false'; ?>;

          const map = L.map(<?php echo wp_json_encode($map_id); ?>).setView(center, zoom);

          // OpenStreetMap tiles
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap'
          }).addTo(map);

          const layerGroup = useCluster ? L.markerClusterGroup() : L.layerGroup();

          function escapeHtml(s){
            return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          }

          function popupHtml(props){
            const title = props?.title ? escapeHtml(props.title) : 'Project';
            const url = props?.url ? String(props.url) : '';
            const thumb = props?.thumb_url ? String(props.thumb_url) : '';
            const category = props?.category ? escapeHtml(props.category) : '';

            const img = thumb ? `<div style="margin:0 0 8px 0;"><img src="${escapeHtml(thumb)}" alt="" style="width:100%;max-width:260px;border-radius:12px;display:block;"></div>` : '';
            const cat = category ? `<div style="font-size:12px;opacity:.75;margin-top:2px;">${category}</div>` : '';
            const link = url ? `<div style="margin-top:8px;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">View project</a></div>` : '';

            return `<div style="max-width:260px;">
              <div style="font-weight:700;">${title}</div>
              ${cat}
              ${img}
              ${link}
            </div>`;
          }

          fetch(feedUrl, { credentials: 'omit' })
            .then(r => {
              if(!r.ok) throw new Error('Feed error ' + r.status);
              return r.json();
            })
            .then(geojson => {
              const features = geojson?.features || [];
              if (!features.length) return;

              for (const f of features) {
                const c = f?.geometry?.coordinates;
                if (!c || c.length < 2) continue;
                const lng = c[0], lat = c[1];
                const marker = L.marker([lat, lng]);
                marker.bindPopup(popupHtml(f.properties || {}), { maxWidth: 280 });
                layerGroup.addLayer(marker);
              }

              layerGroup.addTo(map);

              // Fit bounds (nice UX)
              const bounds = layerGroup.getBounds && layerGroup.getBounds();
              if (bounds && bounds.isValid && bounds.isValid()) {
                map.fitBounds(bounds.pad(0.15));
              }
            })
            .catch(err => {
                console.error(err);
            });
        })();
      </script>
    <?php
    return ob_get_clean();
    }
}

new HTC_Projects_Map();

