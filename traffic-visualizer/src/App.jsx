import {
  startTransition,
  useDeferredValue,
  useEffect,
  useState,
} from "react";
import {
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import Papa from "papaparse";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";

const BENGALURU_CENTER = [12.9716, 77.5946];
const BENGALURU_BOUNDS = [
  [12.79, 77.30],
  [13.28, 77.79],
];

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "UTC",
});

const MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

const HEAT_OPTIONS = [
  { id: "impact", label: "Impact" },
  { id: "closure", label: "Closure" },
  { id: "manpower", label: "Manpower" },
];

const SEVERITY_META = {
  critical: {
    label: "Critical",
    color: "#ef4444",
    surface:
      "border-red-500/30 bg-red-500/10 text-red-100 shadow-[0_0_0_1px_rgba(239,68,68,0.18)]",
  },
  hot: {
    label: "Hot",
    color: "#f97316",
    surface:
      "border-orange-500/30 bg-orange-500/10 text-orange-100 shadow-[0_0_0_1px_rgba(249,115,22,0.18)]",
  },
  watch: {
    label: "Watch",
    color: "#facc15",
    surface:
      "border-yellow-400/30 bg-yellow-400/10 text-yellow-50 shadow-[0_0_0_1px_rgba(250,204,21,0.16)]",
  },
  stable: {
    label: "Stable",
    color: "#2dd4bf",
    surface:
      "border-teal-400/30 bg-teal-400/10 text-teal-50 shadow-[0_0_0_1px_rgba(45,212,191,0.16)]",
  },
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cleanField(value, fallback = "Unknown") {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  if (!normalized || normalized.toLowerCase() === "null") {
    return fallback;
  }

  return normalized;
}

function humanizeLabel(value) {
  return cleanField(value)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .replace(/\bVip\b/g, "VIP")
    .replace(/\bOrr\b/g, "ORR")
    .replace(/\bIrr\b/g, "IRR")
    .replace(/\bCbd\b/g, "CBD");
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatDateLabel(dateString) {
  if (!dateString) {
    return "No date";
  }

  return DATE_FORMATTER.format(new Date(`${dateString}T00:00:00Z`));
}

function extractTimeParts(rawTimestamp) {
  const [dateString = "", timeString = "00:00:00"] = String(rawTimestamp).split(
    " ",
  );
  const [hourText = "0", minuteText = "0"] = timeString.split(":");
  const hour = Number.parseInt(hourText, 10) || 0;
  const minute = Number.parseInt(minuteText, 10) || 0;
  const dateObject = new Date(`${dateString}T00:00:00Z`);

  return {
    dateString,
    hour,
    minute,
    dayLabel: WEEKDAY_FORMATTER.format(dateObject),
    monthLabel: MONTH_FORMATTER.format(dateObject),
    readableDate: DATE_FORMATTER.format(dateObject),
    readableTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function getSeverity(impactScore) {
  if (impactScore >= 2.5) {
    return "critical";
  }

  if (impactScore >= 1.5) {
    return "hot";
  }

  if (impactScore >= 0.75) {
    return "watch";
  }

  return "stable";
}

function getMarkerRadius(event) {
  return 6 + Math.min(12, event.impactScore * 4) + (event.closureProb >= 0.5 ? 2 : 0);
}

function getHeatWeight(event, metric) {
  if (metric === "closure") {
    return clamp(0.15 + event.closureProb * 0.85, 0.15, 1);
  }

  if (metric === "manpower") {
    return clamp(0.15 + event.manpower / 18, 0.15, 1);
  }

  return clamp(0.15 + event.impactScore / 3.8, 0.15, 1);
}

function sumBy(items, accessor) {
  return items.reduce((total, item) => total + accessor(item), 0);
}

function averageBy(items, accessor) {
  return items.length ? sumBy(items, accessor) / items.length : 0;
}

function buildGroupStats(items, accessor, options = {}) {
  const { limit = 5, sortBy = "count", minCount = 1 } = options;
  const groups = new Map();

  for (const item of items) {
    const label = accessor(item);

    if (!groups.has(label)) {
      groups.set(label, {
        label,
        count: 0,
        impactTotal: 0,
        closureTotal: 0,
        manpowerTotal: 0,
      });
    }

    const bucket = groups.get(label);
    bucket.count += 1;
    bucket.impactTotal += item.impactScore;
    bucket.closureTotal += item.closureProb;
    bucket.manpowerTotal += item.manpower;
  }

  const summarized = Array.from(groups.values())
    .filter((group) => group.count >= minCount)
    .map((group) => ({
      ...group,
      impactAvg: group.impactTotal / group.count,
      closureAvg: group.closureTotal / group.count,
      pressure: group.count * (group.impactTotal / group.count),
    }));

  summarized.sort((left, right) => {
    if (sortBy === "impact") {
      return right.impactAvg - left.impactAvg || right.count - left.count;
    }

    if (sortBy === "closure") {
      return right.closureAvg - left.closureAvg || right.count - left.count;
    }

    if (sortBy === "pressure") {
      return right.pressure - left.pressure || right.count - left.count;
    }

    return right.count - left.count || right.impactAvg - left.impactAvg;
  });

  return summarized.slice(0, limit);
}

function buildDailyCounts(items) {
  const counts = new Map();

  for (const item of items) {
    counts.set(item.dateString, (counts.get(item.dateString) || 0) + 1);
  }

  return counts;
}

function buildHourlyCounts(items) {
  const counts = Array.from({ length: 24 }, () => 0);

  for (const item of items) {
    counts[item.hour] += 1;
  }

  return counts;
}

function parseEvent(row, index) {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude <= 0 ||
    longitude <= 0
  ) {
    return null;
  }

  if (
    latitude < BENGALURU_BOUNDS[0][0] ||
    latitude > BENGALURU_BOUNDS[1][0] ||
    longitude < BENGALURU_BOUNDS[0][1] ||
    longitude > BENGALURU_BOUNDS[1][1]
  ) {
    return null;
  }

  const rawTimestamp = cleanField(row.start_datetime, "");
  if (!rawTimestamp) {
    return null;
  }

  const timeParts = extractTimeParts(rawTimestamp);
  const impactScore = Number(row.impact_score) || 0;
  const closureProb = Number(row.closure_prob) || 0;
  const predictedDurationHours = Number(row.predicted_duration_hrs) || 0;
  const manpower = Number(row.manpower) || 0;
  const barricades = Number(row.barricades) || 0;
  const diversionRoutes = Number(row.diversion_routes) || 0;

  return {
    id: cleanField(row.id, `event-${index}`),
    latitude,
    longitude,
    address: cleanField(row.address, "Location not available"),
    zone: cleanField(row.zone),
    junction: cleanField(row.junction),
    corridor: cleanField(row.corridor),
    priority: cleanField(row.priority, "Unknown"),
    status: cleanField(row.status, "Unknown"),
    eventType: cleanField(row.event_type, "Unknown"),
    eventTypeLabel: humanizeLabel(row.event_type),
    eventCause: cleanField(row.event_cause, "Unknown"),
    eventCauseLabel: humanizeLabel(row.event_cause),
    alertLevel: cleanField(row.alert_level, "LOW"),
    actionNotes: cleanField(
      row.action_notes,
      "Monitor the corridor and dispatch the standard field response.",
    ),
    startTimestamp: rawTimestamp,
    dateString: timeParts.dateString,
    dayLabel: timeParts.dayLabel,
    monthLabel: timeParts.monthLabel,
    readableDate: timeParts.readableDate,
    readableTime: timeParts.readableTime,
    hour: timeParts.hour,
    impactScore,
    closureProb,
    predictedDurationHours,
    manpower,
    barricades,
    diversionRoutes,
    patrolFrequencyMinutes: Number(row.patrol_freq_min) || 0,
    severity: getSeverity(impactScore),
  };
}

function MetricCard({ label, value, helper, accent }) {
  return (
    <div className="panel-surface rounded-[28px] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
            {label}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-white">
            {value}
          </p>
        </div>
        <div
          className="h-3 w-3 rounded-full shadow-[0_0_20px_currentColor]"
          style={{ color: accent, backgroundColor: accent }}
        />
      </div>
      <p className="mt-3 text-sm text-slate-400">{helper}</p>
    </div>
  );
}

function HeatLayer({ events, metric }) {
  const map = useMap();

  useEffect(() => {
    const points = events.map((event) => [
      event.latitude,
      event.longitude,
      getHeatWeight(event, metric),
    ]);

    const heatLayer = L.heatLayer(points, {
      radius: 32,
      blur: 26,
      maxZoom: 14,
      minOpacity: 0.28,
      gradient: {
        0.15: "#2dd4bf",
        0.35: "#84cc16",
        0.55: "#facc15",
        0.75: "#f97316",
        1.0: "#ef4444",
      },
    });

    heatLayer.addTo(map);
    return () => {
      map.removeLayer(heatLayer);
    };
  }, [events, map, metric]);

  return null;
}

function App() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDateIndex, setSelectedDateIndex] = useState(0);
  const [selectedHour, setSelectedHour] = useState(6);
  const [heatMetric, setHeatMetric] = useState("impact");
  const [showMarkers, setShowMarkers] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    Papa.parse("/event_congestion_scored_output.csv", {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsedEvents = results.data
          .map((row, index) => parseEvent(row, index))
          .filter(Boolean);

        if (!parsedEvents.length) {
          setError("No Bengaluru incidents were found in the scored output.");
          setLoading(false);
          return;
        }

        const uniqueDates = Array.from(
          new Set(parsedEvents.map((event) => event.dateString)),
        ).sort();

        const dailyCounts = buildDailyCounts(parsedEvents);
        const busiestDayEntry = Array.from(dailyCounts.entries()).sort(
          (left, right) => right[1] - left[1],
        )[0];

        const busiestDay = busiestDayEntry ? busiestDayEntry[0] : uniqueDates[0];
        const busiestDayEvents = parsedEvents.filter(
          (event) => event.dateString === busiestDay,
        );
        const busiestDayHours = buildHourlyCounts(busiestDayEvents);
        const busiestHour = busiestDayHours.indexOf(Math.max(...busiestDayHours));

        setEvents(parsedEvents);
        setSelectedDateIndex(Math.max(0, uniqueDates.indexOf(busiestDay)));
        setSelectedHour(busiestHour >= 0 ? busiestHour : 6);
        setLoading(false);
      },
      error: (parseError) => {
        setError(parseError.message || "Failed to read the traffic dataset.");
        setLoading(false);
      },
    });
  }, []);

  const uniqueDates = Array.from(new Set(events.map((event) => event.dateString))).sort();
  const safeDateIndex = clamp(
    selectedDateIndex,
    0,
    Math.max(0, uniqueDates.length - 1),
  );
  const selectedDate = uniqueDates[safeDateIndex] || "";

  useEffect(() => {
    if (!isPlaying || uniqueDates.length <= 1) {
      return undefined;
    }

    const playback = window.setInterval(() => {
      setSelectedEventId(null);
      setSelectedDateIndex((currentIndex) => {
        if (currentIndex >= uniqueDates.length - 1) {
          setIsPlaying(false);
          return currentIndex;
        }

        return currentIndex + 1;
      });
    }, 1200);

    return () => {
      window.clearInterval(playback);
    };
  }, [isPlaying, uniqueDates.length]);

  const selectedDayEvents = events.filter(
    (event) => event.dateString === selectedDate,
  );
  const selectedHourEvents = selectedDayEvents.filter(
    (event) => event.hour === selectedHour,
  );

  const dayEvents = useDeferredValue(selectedDayEvents);
  const hourEvents = useDeferredValue(selectedHourEvents);

  const dailyCounts = buildDailyCounts(events);
  const busiestDayEntry = Array.from(dailyCounts.entries()).sort(
    (left, right) => right[1] - left[1],
  )[0];
  const busiestDayIndex = busiestDayEntry
    ? uniqueDates.indexOf(busiestDayEntry[0])
    : 0;

  const overallHourlyCounts = buildHourlyCounts(events);
  const peakHour = overallHourlyCounts.indexOf(Math.max(...overallHourlyCounts, 0));
  const peakHourCount = Math.max(...overallHourlyCounts, 0);
  const plannedShare = events.length
    ? Math.round(
        (events.filter((event) => event.eventType === "planned").length /
          events.length) *
          100,
      )
    : 0;
  const topRiskCause = buildGroupStats(events, (event) => event.eventCauseLabel, {
    sortBy: "closure",
    minCount: 10,
    limit: 1,
  })[0];
  const topCorridor = buildGroupStats(
    events.filter((event) => event.corridor !== "Non-corridor"),
    (event) => event.corridor,
    { sortBy: "count", limit: 1 },
  )[0];
  const averageDailyVolume = uniqueDates.length ? events.length / uniqueDates.length : 0;

  const hourAverageImpact = averageBy(hourEvents, (event) => event.impactScore);
  const hourAverageClosure = averageBy(hourEvents, (event) => event.closureProb);
  const hourAverageDuration = averageBy(
    hourEvents,
    (event) => event.predictedDurationHours,
  );
  const hourHighRiskEvents = hourEvents.filter(
    (event) => event.closureProb >= 0.5,
  ).length;

  const dayManpower = sumBy(dayEvents, (event) => event.manpower);
  const dayBarricades = sumBy(dayEvents, (event) => event.barricades);
  const dayDiversions = sumBy(dayEvents, (event) => event.diversionRoutes);
  const dayPatrolMinutes = averageBy(
    dayEvents,
    (event) => event.patrolFrequencyMinutes,
  );
  const dayPlannedShare = dayEvents.length
    ? Math.round(
        (dayEvents.filter((event) => event.eventType === "planned").length /
          dayEvents.length) *
          100,
      )
    : 0;
  const namedCorridorCount = new Set(
    dayEvents
      .filter((event) => event.corridor !== "Unknown")
      .map((event) => event.corridor),
  ).size;
  const namedZoneCount = new Set(
    dayEvents.filter((event) => event.zone !== "Unknown").map((event) => event.zone),
  ).size;

  const dayCauseMix = buildGroupStats(dayEvents, (event) => event.eventCauseLabel, {
    limit: 6,
  });
  const corridorCandidates = dayEvents.filter(
    (event) => event.corridor !== "Unknown" && event.corridor !== "Non-corridor",
  );
  const corridorWatch = buildGroupStats(
    corridorCandidates.length ? corridorCandidates : dayEvents,
    (event) => event.corridor,
    { limit: 6, sortBy: "pressure" },
  );
  const zoneSpread = buildGroupStats(
    dayEvents.filter((event) => event.zone !== "Unknown"),
    (event) => event.zone,
    { limit: 6 },
  );
  const hotspotJunctions = buildGroupStats(
    dayEvents.filter((event) => event.junction !== "Unknown"),
    (event) => event.junction,
    { limit: 5, sortBy: "pressure" },
  );

  const hourlyRhythm = HOURS.map((hour) => {
    const bucket = dayEvents.filter((event) => event.hour === hour);
    return {
      hour,
      count: bucket.length,
      avgImpact: averageBy(bucket, (event) => event.impactScore),
    };
  });

  const selectedDayPeak = [...hourlyRhythm].sort((left, right) => {
    return right.count - left.count || right.avgImpact - left.avgImpact;
  })[0];

  const currentQueue = [...hourEvents]
    .sort((left, right) => {
      return (
        right.impactScore - left.impactScore ||
        right.closureProb - left.closureProb ||
        right.manpower - left.manpower
      );
    })
    .slice(0, 5);

  const dominantCause = dayCauseMix[0];
  const dominantJunction = hotspotJunctions[0];
  const dayDelta =
    averageDailyVolume > 0
      ? Math.round(((dayEvents.length - averageDailyVolume) / averageDailyVolume) * 100)
      : 0;

  const maxCauseCount = Math.max(...dayCauseMix.map((item) => item.count), 1);
  const maxCorridorPressure = Math.max(
    ...corridorWatch.map((item) => item.pressure),
    1,
  );
  const maxZoneCount = Math.max(...zoneSpread.map((item) => item.count), 1);
  const maxHourlyCount = Math.max(...hourlyRhythm.map((slot) => slot.count), 1);

  const handleDateSliderChange = (event) => {
    const nextIndex = Number(event.target.value);
    startTransition(() => {
      setSelectedEventId(null);
      setSelectedDateIndex(nextIndex);
      setIsPlaying(false);
    });
  };

  const handleHourSliderChange = (event) => {
    const nextHour = Number(event.target.value);
    startTransition(() => {
      setSelectedEventId(null);
      setSelectedHour(nextHour);
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(250,204,21,0.08),_transparent_38%),linear-gradient(180deg,_#071019,_#030712)] px-6 py-12">
        <div className="mx-auto flex min-h-[70vh] max-w-6xl items-center justify-center">
          <div className="panel-surface rounded-[32px] px-8 py-10 text-center">
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-amber-300">
              Loading
            </p>
            <h1 className="mt-4 text-3xl font-semibold text-white">
              Building the Bengaluru traffic control room
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
              Reading the scored Astram incidents, preparing the timeline, and
              weighting every location for the congestion heatmap.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(239,68,68,0.12),_transparent_38%),linear-gradient(180deg,_#071019,_#030712)] px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <div className="panel-surface rounded-[32px] border border-red-500/30 px-8 py-10">
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-red-300">
              Dataset issue
            </p>
            <h1 className="mt-4 text-3xl font-semibold text-white">
              The visualizer could not be initialized
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(250,204,21,0.08),_transparent_38%),linear-gradient(180deg,_#071019,_#030712)] text-slate-100">
      <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.26em] text-amber-200">
              Bengaluru event congestion intelligence
            </div>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Heatmaps, timelines, and deployment signals for city traffic ops
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
              A Bengaluru-only control room built from 8,173 Astram incidents,
              combining congestion heatmaps, hotspot drill-down, and operational
              planning cues from your scored model output.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="panel-surface rounded-[24px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                Coverage
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {formatDateLabel(uniqueDates[0])}
              </p>
              <p className="text-sm text-slate-400">
                to {formatDateLabel(uniqueDates[uniqueDates.length - 1])}
              </p>
            </div>
            <div className="panel-surface rounded-[24px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                Overall peak hour
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {formatHour(peakHour)}
              </p>
              <p className="text-sm text-slate-400">{peakHourCount} incidents</p>
            </div>
            <div className="panel-surface rounded-[24px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                Planned share
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {plannedShare}%
              </p>
              <p className="text-sm text-slate-400">
                Unplanned dominates the dataset
              </p>
            </div>
            <div className="panel-surface rounded-[24px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                Highest closure risk
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {topRiskCause?.label || "No signal"}
              </p>
              <p className="text-sm text-slate-400">
                {topRiskCause
                  ? `${Math.round(topRiskCause.closureAvg * 100)}% average closure risk`
                  : "Insufficient incidents"}
              </p>
            </div>
          </div>
        </header>

        <section className="panel-surface mt-6 rounded-[32px] p-5 sm:p-6">
          <div className="grid gap-6 xl:grid-cols-[2.2fr_1fr]">
            <div className="space-y-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                    Date timeline
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">
                    {selectedDate ? formatDateLabel(selectedDate) : "No date selected"}
                  </h2>
                  <p className="mt-2 text-sm text-slate-400">
                    {dayEvents.length} incidents on this day,{" "}
                    {dayDelta >= 0 ? "+" : ""}
                    {dayDelta}% versus the average Bengaluru day in the dataset.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(() => {
                        setSelectedEventId(null);
                        setSelectedDateIndex((current) => Math.max(0, current - 1));
                        setIsPlaying(false);
                      })
                    }
                    className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm text-slate-100 transition hover:border-amber-300/40 hover:bg-white/10"
                  >
                    Previous day
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPlaying((current) => !current)}
                    className="rounded-full border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-sm text-amber-100 transition hover:bg-amber-300/16"
                  >
                    {isPlaying ? "Pause playback" : "Play timeline"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(() => {
                        setSelectedEventId(null);
                        setSelectedDateIndex((current) =>
                          Math.min(uniqueDates.length - 1, current + 1),
                        );
                        setIsPlaying(false);
                      })
                    }
                    className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm text-slate-100 transition hover:border-amber-300/40 hover:bg-white/10"
                  >
                    Next day
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(() => {
                        setSelectedEventId(null);
                        setSelectedDateIndex(Math.max(0, busiestDayIndex));
                        setIsPlaying(false);
                      })
                    }
                    className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm text-slate-100 transition hover:border-amber-300/40 hover:bg-white/10"
                  >
                    Jump to busiest day
                  </button>
                </div>
              </div>

              <div>
                <input
                  type="range"
                  min="0"
                  max={Math.max(0, uniqueDates.length - 1)}
                  value={safeDateIndex}
                  onChange={handleDateSliderChange}
                  className="control-slider w-full"
                  aria-label="Selected date"
                />
                <div className="mt-2 flex justify-between text-xs text-slate-500">
                  <span>{formatDateLabel(uniqueDates[0])}</span>
                  <span>{formatDateLabel(uniqueDates[uniqueDates.length - 1])}</span>
                </div>
              </div>

              <div className="rounded-[28px] border border-white/10 bg-slate-950/35 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                      Reported hour focus
                    </p>
                    <h3 className="mt-2 text-xl font-semibold text-white">
                      {formatHour(selectedHour)}
                    </h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {hourEvents.length} incidents in the current hour slice on{" "}
                      {selectedDate ? formatDateLabel(selectedDate) : "this day"}.
                    </p>
                  </div>
                  <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs uppercase tracking-[0.2em] text-slate-300">
                    Source hours follow the Astram event timestamp fields
                  </div>
                </div>

                <div className="mt-4">
                  <input
                    type="range"
                    min="0"
                    max="23"
                    value={selectedHour}
                    onChange={handleHourSliderChange}
                    className="control-slider w-full"
                    aria-label="Selected hour"
                  />
                  <div className="mt-2 flex justify-between text-xs text-slate-500">
                    <span>00:00</span>
                    <span>06:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>23:00</span>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    Dominant cause
                  </p>
                  <p className="mt-2 text-lg font-semibold text-white">
                    {dominantCause?.label || "No signal"}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {dominantCause
                      ? `${dominantCause.count} incidents on the selected day`
                      : "No cause breakdown available"}
                  </p>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    Peak day hour
                  </p>
                  <p className="mt-2 text-lg font-semibold text-white">
                    {selectedDayPeak ? formatHour(selectedDayPeak.hour) : "--:--"}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {selectedDayPeak
                      ? `${selectedDayPeak.count} logged incidents`
                      : "No hourly signal available"}
                  </p>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    Planned share
                  </p>
                  <p className="mt-2 text-lg font-semibold text-white">
                    {dayPlannedShare}%
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {100 - dayPlannedShare}% unplanned on this day
                  </p>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-slate-950/35 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    Geo coverage
                  </p>
                  <p className="mt-2 text-lg font-semibold text-white">
                    {namedCorridorCount} corridors
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {namedZoneCount} named zones tagged in the slice
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-[28px] border border-white/10 bg-slate-950/35 p-4">
                <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                  Map rendering
                </p>
                <div className="mt-4 grid gap-2">
                  {HEAT_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() =>
                        startTransition(() => {
                          setHeatMetric(option.id);
                        })
                      }
                      className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                        heatMetric === option.id
                          ? "border-amber-300/35 bg-amber-300/12 text-amber-50"
                          : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/8"
                      }`}
                    >
                      <div className="font-semibold">{option.label} heatmap</div>
                      <div className="mt-1 text-xs text-slate-400">
                        {option.id === "impact" &&
                          "Weights stronger congestion scores more heavily."}
                        {option.id === "closure" &&
                          "Highlights where closure probability is concentrated."}
                        {option.id === "manpower" &&
                          "Shows where your staffing recommendation accumulates."}
                      </div>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setSelectedEventId(null);
                    setShowMarkers((current) => !current);
                  }}
                  className={`mt-4 w-full rounded-2xl border px-4 py-3 text-sm transition ${
                    showMarkers
                      ? "border-teal-400/30 bg-teal-400/10 text-teal-50"
                      : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/8"
                  }`}
                >
                  {showMarkers ? "Markers enabled for incident drill-down" : "Markers hidden for pure density view"}
                </button>
              </div>

              <div className="rounded-[28px] border border-white/10 bg-slate-950/35 p-4">
                <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                  Bengaluru baseline
                </p>
                <div className="mt-4 space-y-3 text-sm text-slate-300">
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-3">
                    <p className="font-semibold text-white">
                      {busiestDayEntry
                        ? `${formatDateLabel(busiestDayEntry[0])} was the busiest recorded day`
                        : "Daily peak unavailable"}
                    </p>
                    <p className="mt-1 text-slate-400">
                      {busiestDayEntry
                        ? `${busiestDayEntry[1]} incidents were logged that day.`
                        : "The dataset does not contain a valid daily peak."}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-3">
                    <p className="font-semibold text-white">
                      {topCorridor
                        ? `${topCorridor.label} is the busiest named corridor`
                        : "Corridor signal unavailable"}
                    </p>
                    <p className="mt-1 text-slate-400">
                      {topCorridor
                        ? `${topCorridor.count} incidents across the full Bengaluru footprint.`
                        : "Try checking the source corridor fields."}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-3">
                    <p className="font-semibold text-white">
                      Peak reporting returns at {formatHour(peakHour)}
                    </p>
                    <p className="mt-1 text-slate-400">
                      The same dataset also carries a strong early-morning spike,
                      which the hourly rhythm panel makes easy to compare.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <MetricCard
            label="Hour slice"
            value={hourEvents.length}
            helper={`${dayEvents.length} incidents across the selected day`}
            accent="#2dd4bf"
          />
          <MetricCard
            label="Avg impact"
            value={hourAverageImpact.toFixed(2)}
            helper={
              hourEvents.length
                ? `Highest queue item reaches ${currentQueue[0]?.impactScore.toFixed(2)}`
                : "Move the timeline to a busier hour for stronger signals"
            }
            accent="#f97316"
          />
          <MetricCard
            label="Closure risk"
            value={`${Math.round(hourAverageClosure * 100)}%`}
            helper={`${hourHighRiskEvents} incidents above 50% closure probability`}
            accent="#ef4444"
          />
          <MetricCard
            label="Predicted duration"
            value={`${hourAverageDuration.toFixed(1)}h`}
            helper="Mean predicted time to clear in the selected slice"
            accent="#facc15"
          />
          <MetricCard
            label="Daily manpower"
            value={dayManpower}
            helper={`${dayDiversions} diversions and ${Math.round(dayPatrolMinutes || 0)} min patrol cadence`}
            accent="#60a5fa"
          />
          <MetricCard
            label="Daily barricades"
            value={dayBarricades}
            helper={`${hotspotJunctions.length} named junction hotspots on this day`}
            accent="#c084fc"
          />
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[1.65fr_0.95fr]">
          <div className="panel-surface rounded-[34px] p-4 sm:p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                  Bengaluru heatmap
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-white">
                  {HEAT_OPTIONS.find((option) => option.id === heatMetric)?.label} density for {formatHour(selectedHour)}
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  The map is locked to the Bengaluru operating footprint to keep
                  focus on the city-scale congestion picture.
                </p>
              </div>
              <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs uppercase tracking-[0.22em] text-slate-300">
                {selectedDate ? formatDateLabel(selectedDate) : "No day"} at{" "}
                {formatHour(selectedHour)}
              </div>
            </div>

            <div className="relative mt-4 overflow-hidden rounded-[28px] border border-white/10">
              <div className="h-[560px]">
                <MapContainer
                  center={BENGALURU_CENTER}
                  zoom={11}
                  minZoom={11}
                  maxZoom={15}
                  maxBounds={BENGALURU_BOUNDS}
                  maxBoundsViscosity={1}
                  preferCanvas
                  style={{ height: "100%", width: "100%" }}
                  className="z-0"
                >
                  <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; OpenStreetMap contributors &copy; CARTO'
                  />

                  <HeatLayer events={hourEvents} metric={heatMetric} />

                  {showMarkers &&
                    hourEvents.map((event) => (
                      <CircleMarker
                        key={event.id}
                        center={[event.latitude, event.longitude]}
                        radius={getMarkerRadius(event)}
                        fillColor={SEVERITY_META[event.severity].color}
                        color="rgba(255,255,255,0.86)"
                        weight={selectedEventId === event.id ? 2.5 : 1.4}
                        opacity={0.9}
                        fillOpacity={selectedEventId === event.id ? 0.95 : 0.76}
                        eventHandlers={{
                          click: () => setSelectedEventId(event.id),
                        }}
                      >
                        {selectedEventId === event.id && (
                          <Popup>
                            <div className="min-w-[240px] space-y-3 p-1">
                              <div>
                                <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                                  {event.eventTypeLabel}
                                </p>
                                <h3 className="mt-1 text-base font-semibold text-white">
                                  {event.eventCauseLabel}
                                </h3>
                                <p className="mt-1 text-xs text-slate-400">
                                  {event.readableDate} at {event.readableTime}
                                </p>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-xs text-slate-200">
                                <div className="rounded-xl bg-slate-900/80 p-2">
                                  <p className="text-slate-400">Impact</p>
                                  <p className="mt-1 font-semibold">
                                    {event.impactScore.toFixed(2)}
                                  </p>
                                </div>
                                <div className="rounded-xl bg-slate-900/80 p-2">
                                  <p className="text-slate-400">Closure risk</p>
                                  <p className="mt-1 font-semibold">
                                    {Math.round(event.closureProb * 100)}%
                                  </p>
                                </div>
                                <div className="rounded-xl bg-slate-900/80 p-2">
                                  <p className="text-slate-400">Duration</p>
                                  <p className="mt-1 font-semibold">
                                    {event.predictedDurationHours.toFixed(1)}h
                                  </p>
                                </div>
                                <div className="rounded-xl bg-slate-900/80 p-2">
                                  <p className="text-slate-400">Manpower</p>
                                  <p className="mt-1 font-semibold">{event.manpower}</p>
                                </div>
                              </div>

                              <div className="space-y-1 text-xs text-slate-300">
                                <p>
                                  <span className="font-semibold text-white">
                                    Corridor:
                                  </span>{" "}
                                  {event.corridor}
                                </p>
                                <p>
                                  <span className="font-semibold text-white">
                                    Junction:
                                  </span>{" "}
                                  {event.junction}
                                </p>
                                <p>
                                  <span className="font-semibold text-white">
                                    Zone:
                                  </span>{" "}
                                  {event.zone}
                                </p>
                                <p>
                                  <span className="font-semibold text-white">
                                    Status:
                                  </span>{" "}
                                  {humanizeLabel(event.status)}
                                </p>
                              </div>

                              <div className="rounded-xl border border-white/8 bg-slate-900/80 p-3 text-xs text-slate-300">
                                <p className="font-semibold text-white">Action note</p>
                                <p className="mt-1 leading-5">{event.actionNotes}</p>
                              </div>

                              <p className="text-xs leading-5 text-slate-400">
                                {event.address}
                              </p>
                            </div>
                          </Popup>
                        )}
                      </CircleMarker>
                    ))}
                </MapContainer>
              </div>

              {hourEvents.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/45 p-6 text-center backdrop-blur-[1px]">
                  <div className="rounded-[24px] border border-white/10 bg-slate-950/75 px-6 py-5">
                    <p className="text-sm font-medium uppercase tracking-[0.24em] text-slate-400">
                      No incidents in this hour slice
                    </p>
                    <p className="mt-3 max-w-md text-sm leading-6 text-slate-300">
                      Try a neighboring hour or use the daily rhythm panel below
                      to jump directly to the busiest reporting window.
                    </p>
                  </div>
                </div>
              )}

              <div className="absolute inset-x-4 bottom-4 z-[500] grid gap-3 lg:grid-cols-[1.2fr_1fr]">
                <div className="rounded-[22px] border border-white/10 bg-slate-950/78 px-4 py-3 shadow-2xl backdrop-blur-md">
                  <p className="text-xs font-medium uppercase tracking-[0.22em] text-slate-400">
                    Heat intensity
                  </p>
                  <div className="mt-3 h-2 rounded-full bg-[linear-gradient(90deg,_#2dd4bf_0%,_#84cc16_25%,_#facc15_55%,_#f97316_78%,_#ef4444_100%)]" />
                  <div className="mt-2 flex justify-between text-[11px] uppercase tracking-[0.16em] text-slate-400">
                    <span>Low</span>
                    <span>Rising</span>
                    <span>Severe</span>
                  </div>
                </div>

                <div className="rounded-[22px] border border-white/10 bg-slate-950/78 px-4 py-3 shadow-2xl backdrop-blur-md">
                  <p className="text-xs font-medium uppercase tracking-[0.22em] text-slate-400">
                    Marker severity
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-300">
                    {Object.entries(SEVERITY_META).map(([key, meta]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: meta.color }}
                        />
                        <span>{meta.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="grid gap-4">
            <div className="panel-surface rounded-[30px] p-5">
              <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                Current hour queue
              </p>
              <h3 className="mt-2 text-xl font-semibold text-white">
                Priority incidents to inspect
              </h3>
              <div className="mt-4 space-y-3">
                {currentQueue.length ? (
                  currentQueue.map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => setSelectedEventId(event.id)}
                      className={`w-full rounded-[24px] border p-4 text-left transition hover:translate-y-[-1px] ${
                        SEVERITY_META[event.severity].surface
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-300/80">
                            {event.eventTypeLabel}
                          </p>
                          <h4 className="mt-1 text-base font-semibold text-white">
                            {event.eventCauseLabel}
                          </h4>
                        </div>
                        <div className="text-right text-xs text-slate-200">
                          <p>{event.impactScore.toFixed(2)} impact</p>
                          <p className="mt-1">
                            {Math.round(event.closureProb * 100)}% closure risk
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-200">
                        <span className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1">
                          {event.corridor}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1">
                          {event.manpower} personnel
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1">
                          {event.barricades} barricades
                        </span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="rounded-[24px] border border-dashed border-white/12 bg-white/5 p-4 text-sm text-slate-400">
                    No incidents at this exact hour. The heatmap remains scoped to
                    the selected slice so you can compare quieter windows too.
                  </div>
                )}
              </div>
            </div>

            <div className="panel-surface rounded-[30px] p-5">
              <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                Deployment deck
              </p>
              <h3 className="mt-2 text-xl font-semibold text-white">
                Daily resource posture
              </h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    Manpower
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-white">
                    {dayManpower}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Total personnel recommended for the day
                  </p>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    Barricades
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-white">
                    {dayBarricades}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Physical traffic control assets recommended
                  </p>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    Diversions
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-white">
                    {dayDiversions}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Alternate route activations for the day
                  </p>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    Patrol cadence
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-white">
                    {Math.round(dayPatrolMinutes || 0)} min
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Average revisit interval across incidents
                  </p>
                </div>
              </div>
            </div>

            <div className="panel-surface rounded-[30px] p-5">
              <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
                Control room notes
              </p>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="font-semibold text-white">
                    {selectedDayPeak?.count
                      ? `${formatHour(selectedDayPeak.hour)} is the heaviest hour on this day`
                      : "No hourly peak available"}
                  </p>
                  <p className="mt-1 text-slate-400">
                    {selectedDayPeak?.count
                      ? `${selectedDayPeak.count} incidents with an average impact score of ${selectedDayPeak.avgImpact.toFixed(2)}.`
                      : "Move the date timeline to a day with incident activity."}
                  </p>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="font-semibold text-white">
                    {dominantCause
                      ? `${dominantCause.label} is the dominant cause today`
                      : "Cause mix unavailable"}
                  </p>
                  <p className="mt-1 text-slate-400">
                    {dominantCause
                      ? `${dominantCause.count} incidents and ${Math.round(dominantCause.closureAvg * 100)}% mean closure risk.`
                      : "The selected day has no incident records."}
                  </p>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                  <p className="font-semibold text-white">
                    {dominantJunction
                      ? `${dominantJunction.label} is the busiest named junction today`
                      : "Named junction signal unavailable"}
                  </p>
                  <p className="mt-1 text-slate-400">
                    {dominantJunction
                      ? `${dominantJunction.count} incidents around the junction footprint.`
                      : "Most incidents for this day are not tagged to a named junction."}
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </section>

        <section className="mt-6 grid gap-6 2xl:grid-cols-4 xl:grid-cols-2">
          <div className="panel-surface rounded-[30px] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
              Cause mix
            </p>
            <h3 className="mt-2 text-xl font-semibold text-white">
              Which incident types shape the day
            </h3>
            <div className="mt-5 space-y-4">
              {dayCauseMix.length ? (
                dayCauseMix.map((item) => (
                  <div key={item.label}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-100">{item.label}</span>
                      <span className="text-slate-400">{item.count} incidents</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-900/80">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,_#2dd4bf,_#facc15,_#ef4444)]"
                        style={{
                          width: `${(item.count / maxCauseCount) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                      <span>{item.impactAvg.toFixed(2)} avg impact</span>
                      <span>{Math.round(item.closureAvg * 100)}% closure risk</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-[22px] border border-dashed border-white/12 bg-white/5 p-4 text-sm text-slate-400">
                  No cause breakdown is available for this day.
                </div>
              )}
            </div>
          </div>

          <div className="panel-surface rounded-[30px] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
              Daily rhythm
            </p>
            <h3 className="mt-2 text-xl font-semibold text-white">
              Click an hour to move the map instantly
            </h3>
            <div className="mt-5">
              <div className="flex h-52 items-end gap-1">
                {hourlyRhythm.map((slot) => {
                  const isActive = slot.hour === selectedHour;
                  const height = `${(slot.count / maxHourlyCount) * 100}%`;
                  const impactAlpha = clamp(slot.avgImpact / 2.5, 0.18, 1);

                  return (
                    <button
                      key={slot.hour}
                      type="button"
                      onClick={() =>
                        startTransition(() => {
                          setSelectedEventId(null);
                          setSelectedHour(slot.hour);
                        })
                      }
                      title={`${formatHour(slot.hour)} • ${slot.count} incidents • ${slot.avgImpact.toFixed(2)} avg impact`}
                      className={`flex flex-1 items-end rounded-t-2xl transition ${
                        isActive ? "outline outline-2 outline-amber-300/60" : ""
                      }`}
                    >
                      <span
                        className="w-full rounded-t-2xl"
                        style={{
                          height,
                          background: `linear-gradient(180deg, rgba(250,204,21,${impactAlpha}) 0%, rgba(239,68,68,${Math.min(impactAlpha + 0.08, 1)}) 100%)`,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
              <p className="mt-3 text-sm text-slate-400">
                Taller bars mean more incidents. Warmer bars mean higher average
                impact during that hour.
              </p>
            </div>
          </div>

          <div className="panel-surface rounded-[30px] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
              Corridor watchlist
            </p>
            <h3 className="mt-2 text-xl font-semibold text-white">
              Highest-pressure travel corridors
            </h3>
            <div className="mt-5 space-y-4">
              {corridorWatch.length ? (
                corridorWatch.map((item) => (
                  <div key={item.label}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-100">{item.label}</span>
                      <span className="text-slate-400">
                        {item.count} incidents
                      </span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-900/80">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,_#60a5fa,_#a78bfa,_#f97316)]"
                        style={{
                          width: `${(item.pressure / maxCorridorPressure) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                      <span>{item.impactAvg.toFixed(2)} avg impact</span>
                      <span>{item.manpowerTotal} manpower load</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-[22px] border border-dashed border-white/12 bg-white/5 p-4 text-sm text-slate-400">
                  No corridor names are available for the selected day.
                </div>
              )}
            </div>
          </div>

          <div className="panel-surface rounded-[30px] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-400">
              Zone spread
            </p>
            <h3 className="mt-2 text-xl font-semibold text-white">
              Geographic distribution across the city
            </h3>
            <div className="mt-5 space-y-4">
              {zoneSpread.length ? (
                zoneSpread.map((item) => (
                  <div key={item.label}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-100">{item.label}</span>
                      <span className="text-slate-400">{item.count} incidents</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-900/80">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,_#2dd4bf,_#60a5fa)]"
                        style={{
                          width: `${(item.count / maxZoneCount) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                      <span>{item.impactAvg.toFixed(2)} avg impact</span>
                      <span>{Math.round(item.closureAvg * 100)}% closure risk</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-[22px] border border-dashed border-white/12 bg-white/5 p-4 text-sm text-slate-400">
                  Zone metadata is sparse for this day, so the map remains the
                  best location signal.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
