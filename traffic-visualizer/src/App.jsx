import { useState, useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import Papa from "papaparse";
import "leaflet/dist/leaflet.css";

function App() {
  const [events, setEvents] = useState([]);
  const [filteredEvents, setFilteredEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedHour, setSelectedHour] = useState(12);
  const [dateRange, setDateRange] = useState({ min: "", max: "" });
  const [showPopup, setShowPopup] = useState(null);

  useEffect(() => {
    // Load and parse CSV data
    Papa.parse("/event_congestion_scored_output.csv", {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsedData = results.data.filter(
          (event) => event.latitude && event.longitude && event.start_datetime,
        );

        // Parse dates and extract hour
        const processedData = parsedData.map((event) => {
          const date = new Date(event.start_datetime);
          return {
            ...event,
            dateObj: date,
            dateStr: date.toISOString().split("T")[0],
            hour: date.getHours(),
          };
        });

        setEvents(processedData);

        // Calculate date range
        const dates = processedData.map((e) => e.dateStr).sort();
        if (dates.length > 0) {
          setDateRange({ min: dates[0], max: dates[dates.length - 1] });
          setSelectedDate(dates[Math.floor(dates.length / 2)]); // Select middle date
        }

        setLoading(false);
      },
      error: (error) => {
        console.error("Error parsing CSV:", error);
        setLoading(false);
      },
    });
  }, []);

  useEffect(() => {
    // Filter events based on selected date and hour
    if (events.length === 0) return;

    const filtered = events.filter((event) => {
      const dateMatch = !selectedDate || event.dateStr === selectedDate;
      const hourMatch = event.hour === selectedHour;
      return dateMatch && hourMatch;
    });

    setFilteredEvents(filtered);
  }, [events, selectedDate, selectedHour]);

  const getEventColor = (impactScore) => {
    if (impactScore >= 7.5) return "#ef4444"; // red - critical
    if (impactScore >= 5.0) return "#f97316"; // orange - high
    if (impactScore >= 2.5) return "#eab308"; // yellow - medium
    return "#22c55e"; // green - low
  };

  const getEventRadius = (impactScore) => {
    return 8 + impactScore * 1.5; // Radius based on impact score
  };

  const handleDateChange = (e) => {
    setSelectedDate(e.target.value);
  };

  const handleHourChange = (e) => {
    setSelectedHour(parseInt(e.target.value));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading traffic data...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Header */}
      <header className="bg-slate-800/50 backdrop-blur-sm border-b border-slate-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-white">
            Bengaluru Traffic Event Visualizer
          </h1>
          <p className="text-slate-400 text-sm">
            Real-time congestion simulation based on historical traffic
            incidents
          </p>
        </div>
      </header>

      {/* Controls */}
      <div className="bg-slate-800/30 backdrop-blur-sm border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Date Slider */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Date: {selectedDate || "Select a date"}
              </label>
              <input
                type="date"
                min={dateRange.min}
                max={dateRange.max}
                value={selectedDate}
                onChange={handleDateChange}
                className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>{dateRange.min}</span>
                <span>{dateRange.max}</span>
              </div>
            </div>

            {/* Time Slider */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Time: {selectedHour}:00
              </label>
              <input
                type="range"
                min="0"
                max="23"
                value={selectedHour}
                onChange={handleHourChange}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>00:00</span>
                <span>12:00</span>
                <span>23:00</span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="mt-4 flex flex-wrap gap-4">
            <div className="bg-slate-700/50 rounded-lg px-4 py-2">
              <span className="text-slate-400 text-sm">Events: </span>
              <span className="text-white font-semibold">
                {filteredEvents.length}
              </span>
            </div>
            <div className="bg-slate-700/50 rounded-lg px-4 py-2">
              <span className="text-slate-400 text-sm">Critical: </span>
              <span className="text-red-400 font-semibold">
                {filteredEvents.filter((e) => e.impact_score >= 7.5).length}
              </span>
            </div>
            <div className="bg-slate-700/50 rounded-lg px-4 py-2">
              <span className="text-slate-400 text-sm">High: </span>
              <span className="text-orange-400 font-semibold">
                {
                  filteredEvents.filter(
                    (e) => e.impact_score >= 5.0 && e.impact_score < 7.5,
                  ).length
                }
              </span>
            </div>
            <div className="bg-slate-700/50 rounded-lg px-4 py-2">
              <span className="text-slate-400 text-sm">Medium: </span>
              <span className="text-yellow-400 font-semibold">
                {
                  filteredEvents.filter(
                    (e) => e.impact_score >= 2.5 && e.impact_score < 5.0,
                  ).length
                }
              </span>
            </div>
            <div className="bg-slate-700/50 rounded-lg px-4 py-2">
              <span className="text-slate-400 text-sm">Low: </span>
              <span className="text-green-400 font-semibold">
                {filteredEvents.filter((e) => e.impact_score < 2.5).length}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="h-[calc(100vh-280px)]">
        <MapContainer
          center={[12.9716, 77.5946]} // Bengaluru center
          zoom={12}
          style={{ height: "100%", width: "100%" }}
          className="z-0"
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />

          {filteredEvents.map((event) => (
            <CircleMarker
              key={event.id}
              center={[event.latitude, event.longitude]}
              radius={getEventRadius(event.impact_score)}
              fillColor={getEventColor(event.impact_score)}
              color="#fff"
              weight={2}
              opacity={0.8}
              fillOpacity={0.6}
              eventHandlers={{
                click: () => setShowPopup(event.id),
              }}
            >
              {showPopup === event.id && (
                <Popup>
                  <div className="p-2 min-w-[200px]">
                    <h3 className="font-bold text-sm mb-2">
                      {event.event_cause}
                    </h3>
                    <div className="space-y-1 text-xs">
                      <p>
                        <span className="font-semibold">Type:</span>{" "}
                        {event.event_type}
                      </p>
                      <p>
                        <span className="font-semibold">Impact Score:</span>{" "}
                        {event.impact_score?.toFixed(2)}
                      </p>
                      <p>
                        <span className="font-semibold">Alert Level:</span>{" "}
                        {event.alert_level}
                      </p>
                      <p>
                        <span className="font-semibold">Duration:</span>{" "}
                        {event.predicted_duration_hrs?.toFixed(1)} hrs
                      </p>
                      <p>
                        <span className="font-semibold">Road Closure:</span>{" "}
                        {event.closure_prob > 0.5 ? "Yes" : "No"}
                      </p>
                      <p>
                        <span className="font-semibold">Manpower:</span>{" "}
                        {event.manpower}
                      </p>
                      <p className="text-slate-600 mt-2">{event.address}</p>
                    </div>
                  </div>
                </Popup>
              )}
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      {/* Legend */}
      <div className="fixed bottom-4 right-4 bg-slate-800/90 backdrop-blur-sm rounded-lg p-4 border border-slate-700 z-10">
        <h4 className="text-white font-semibold mb-2 text-sm">Impact Score</h4>
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-red-500"></div>
            <span className="text-slate-300">Critical (7.5+)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-orange-500"></div>
            <span className="text-slate-300">High (5.0-7.5)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-yellow-500"></div>
            <span className="text-slate-300">Medium (2.5-5.0)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-green-500"></div>
            <span className="text-slate-300">Low (0-2.5)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
