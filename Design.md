# Design Specification: Bengaluru Traffic Intelligence Dashboard

## Vision
A professional, production-quality command center interface for Bengaluru traffic operations. The design prioritizes geographic intelligence (the map) and operational density, moving away from generic dashboards toward a specialized GIS/Civic tool aesthetic.

## Visual Language
- **Theme:** High-contrast Dark Mode.
- **Color Palette:**
  - **Base:** Deep Charcoal/Black (#0A0A0A) background with subtle dark-grey borders (#1F1F1F).
  - **Functional Colors:**
    - **Critical (Red):** #EF4444 (High impact/closure risk).
    - **Warning (Amber):** #F59E0B (Moderate impact).
    - **Resource (Teal/Green):** #10B981 (Manpower/Barricade loads).
    - **Stable (Muted Blue/Grey):** #64748B.
- **Typography:** 
  - **Primary:** Inter or Roboto (Sans-serif) for high legibility.
  - **Monospace:** JetBrains Mono or Roboto Mono for data values, impact scores, and time stamps to emphasize precision.
- **Atmosphere:** Rugged, reliable, and functional. No "glassmorphism" or decorative gradients. Use crisp borders and distinct panels.

## Layout Structure (Split-Pane)
- **Container:** 100vh / 100vw fixed layout (no global scroll).
- **Sidebar (30% Width):** Dense tactical panel.
  - **Tactical Overview (Header):** 2x3 grid of KPI tiles (Hour Slice, Avg Impact, Closure Risk, Predicted Duration, Manpower, Barricades).
  - **Incident Queue (Middle):** Scrollable list of "Current Priority Incidents" cards. Each card shows cause, impact score, risk %, and required resources.
  - **Resource Deployment (Bottom):** Visualization of current manpower load vs. barricade stock (circular gauges or progress bars).
- **Map View (70% Width):**
  - **Map Style:** Minimalist dark-themed Bengaluru map (e.g., Mapbox Dark or custom Google Maps styling).
  - **Overlays:** Sophisticated Heatmap (Intensity: Red > Yellow > Green) and custom Incident Markers (circles with severity scores).
  - **Floating Controls:** 
    - **Timeline Controller:** Bottom-centered, semi-transparent bar with a scrubbable 24-hour axis and 'Play' toggle.
    - **Map Toggles:** Top-right icon stack for heatmap layers (Impact vs. Closure vs. Manpower).

## Component Specifications

### 1. KPI Tile
- **Style:** Flat card with left-accent border colored by severity.
- **Label:** Small-caps, muted grey.
- **Value:** Large, bold white text.
- **Sub-info:** Inline sparkline or delta (e.g., "+365% vs avg").

### 2. Incident Card
- **Layout:** Flex row with a severity icon/score on the left.
- **Heading:** Bold cause (e.g., "Water Logging").
- **Tags:** Compact pills for location (e.g., "Mysore Road") and resources (e.g., "10 personnel").
- **Contrast:** High-contrast text against a slightly lighter background than the sidebar.

### 3. Timeline Scrub Bar
- **Track:** Thin horizontal line with hourly markers (00:00 - 23:00).
- **Handle:** Prominent circle showing the currently selected hour.
- **Gradient:** A very subtle glow on the track indicating peak intensity periods across the day.

## Functional Requirements for Code
- **Responsive:** On mobile, the Sidebar should transform into a bottom-sheet that can be swiped up to reveal data, keeping the map visible.
- **Interactivity:** Clicking an Incident Card must pan the map to the incident location and open a detailed popup.
- **Performance:** Heatmap rendering must be optimized for ~8,000 data points. Use Canvas-based rendering for the heatmap layer.
