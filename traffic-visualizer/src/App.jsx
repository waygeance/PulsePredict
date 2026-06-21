import { startTransition, useEffect, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import Papa from "papaparse";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";

const BENGALURU_CENTER = [12.9716, 77.5946];
const BENGALURU_DATA_BOUNDS = [
  [12.8, 77.31],
  [13.17, 77.77],
];
const BENGALURU_MAP_BOUNDS = [
  [12.85, 77.46],
  [13.13, 77.73],
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

const HEAT_OPTIONS = [
  { id: "impact", label: "Impact", short: "I" },
  { id: "closure", label: "Closure", short: "C" },
  { id: "manpower", label: "Manpower", short: "M" },
];

const SEVERITY_META = {
  critical: { label: "Critical", color: "#EF4444" },
  hot: { label: "Warning", color: "#F59E0B" },
  watch: { label: "Resource", color: "#10B981" },
  stable: { label: "Stable", color: "#64748B" },
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isWithinBounds(latitude, longitude, bounds) {
  return (
    latitude >= bounds[0][0] &&
    latitude <= bounds[1][0] &&
    longitude >= bounds[0][1] &&
    longitude <= bounds[1][1]
  );
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
  const [dateString = "", timeString = "00:00:00"] =
    String(rawTimestamp).split(" ");
  const [hourText = "0", minuteText = "0"] = timeString.split(":");
  const hour = Number.parseInt(hourText, 10) || 0;
  const minute = Number.parseInt(minuteText, 10) || 0;
  const dateObject = new Date(`${dateString}T00:00:00Z`);

  return {
    dateString,
    hour,
    minute,
    dayLabel: WEEKDAY_FORMATTER.format(dateObject),
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
  return 5 + Math.min(10, event.impactScore * 3.25);
}

function getHeatWeight(event, metric) {
  if (metric === "closure") {
    return clamp(0.1 + event.closureProb * 0.9, 0.1, 1);
  }

  if (metric === "manpower") {
    return clamp(0.12 + event.manpower / 18, 0.12, 1);
  }

  return clamp(0.14 + event.impactScore / 3.8, 0.14, 1);
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

function buildDailyRollups(items) {
  const rollups = new Map();

  for (const item of items) {
    if (!rollups.has(item.dateString)) {
      rollups.set(item.dateString, {
        count: 0,
        manpower: 0,
        barricades: 0,
        diversions: 0,
      });
    }

    const bucket = rollups.get(item.dateString);
    bucket.count += 1;
    bucket.manpower += item.manpower;
    bucket.barricades += item.barricades;
    bucket.diversions += item.diversionRoutes;
  }

  return rollups;
}

function buildTimelineGradient(hourlyRhythm) {
  const maxCount = Math.max(...hourlyRhythm.map((slot) => slot.count), 1);

  const stops = hourlyRhythm.map((slot) => {
    const position = (slot.hour / 23) * 100;
    const intensity = slot.count / maxCount;

    let color = "rgba(100,116,139,0.18)";
    if (intensity > 0.68) {
      color = "rgba(239,68,68,0.34)";
    } else if (intensity > 0.38) {
      color = "rgba(245,158,11,0.28)";
    } else if (intensity > 0.12) {
      color = "rgba(16,185,129,0.22)";
    }

    return `${color} ${position}%`;
  });

  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function buildPriorityQueue(items, limit = 4) {
  const groups = new Map();

  for (const event of items) {
    const key = [
      event.eventTypeLabel,
      event.eventCauseLabel,
      event.corridor,
      event.zone,
    ].join("|");
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { ...event, hotspotCount: 1 });
      continue;
    }

    const nextCount = existing.hotspotCount + 1;
    const shouldReplaceRepresentative =
      event.impactScore > existing.impactScore ||
      (event.impactScore === existing.impactScore &&
        event.closureProb > existing.closureProb);

    groups.set(
      key,
      shouldReplaceRepresentative
        ? { ...event, hotspotCount: nextCount }
        : { ...existing, hotspotCount: nextCount },
    );
  }

  return Array.from(groups.values())
    .sort((left, right) => {
      return (
        right.impactScore - left.impactScore ||
        right.closureProb - left.closureProb ||
        right.hotspotCount - left.hotspotCount ||
        right.manpower - left.manpower
      );
    })
    .slice(0, limit);
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

  if (!isWithinBounds(latitude, longitude, BENGALURU_DATA_BOUNDS)) {
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
    dateString: timeParts.dateString,
    dayLabel: timeParts.dayLabel,
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

function Icon({ path, className = "h-4 w-4" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function RailButton({ title, active, iconPath }) {
  return (
    <button
      type="button"
      title={title}
      className={`rail-button ${active ? "rail-button-active" : ""}`}
      aria-label={title}
    >
      <Icon path={iconPath} />
    </button>
  );
}

function SectionHeader({ title, actions }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#B6BDC9]">
        {title}
      </h2>
      {actions || (
        <button
          type="button"
          className="rounded-md border border-[#262A31] bg-[#14171C] px-2 py-1 text-[11px] text-[#7B8494]"
          aria-label={`${title} options`}
        >
          ...
        </button>
      )}
    </div>
  );
}

function SidebarViewButton({ label, value, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[16px] border px-3 py-3 text-left transition ${
        active
          ? "border-[#334155] bg-[#171B21] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]"
          : "border-[#252932] bg-[#14171C] hover:border-[#313741]"
      }`}
    >
      <p className="text-[10px] uppercase tracking-[0.22em] text-[#7B8494]">
        {label}
      </p>
      <p className="mono-data mt-2 text-lg font-semibold text-white">{value}</p>
    </button>
  );
}

function KpiTile({ label, value, detail, accent }) {
  return (
    <div
      className="rounded-[18px] border border-[#272B33] bg-[#181B20] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
      style={{ boxShadow: `inset 4px 0 0 ${accent}` }}
    >
      <p className="text-[11px] uppercase tracking-[0.22em] text-[#7B8494]">
        {label}
      </p>
      <p className="mono-data mt-2 text-[1.7rem] font-semibold leading-none text-white">
        {value}
      </p>
      <p className="mt-2 text-xs leading-5 text-[#97A2B3]">{detail}</p>
    </div>
  );
}

function IncidentCard({ event, active, onSelect }) {
  const accent = SEVERITY_META[event.severity].color;
  const secondaryLine =
    event.zone !== "Unknown"
      ? event.zone
      : event.junction !== "Unknown"
        ? event.junction
        : `${event.predictedDurationHours.toFixed(1)}h clearance`;
  const summaryLine =
    event.hotspotCount > 1
      ? `${event.hotspotCount} linked hotspots • ${secondaryLine}`
      : secondaryLine;

  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      className={`w-full rounded-[18px] border bg-[#171A1F] p-3 text-left transition ${
        active
          ? "border-[#3B4250] shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
          : "border-[#242830] hover:border-[#313741]"
      }`}
      style={active ? { boxShadow: `inset 3px 0 0 ${accent}` } : undefined}
    >
      <div className="flex gap-3">
        <div
          className="flex w-[68px] shrink-0 flex-col items-center justify-center rounded-2xl border px-2 py-2"
          style={{
            borderColor: `${accent}4D`,
            backgroundColor: `${accent}14`,
            color: accent,
          }}
        >
          <span className="mono-data text-lg font-semibold">
            {event.impactScore.toFixed(2)}
          </span>
          <span className="mt-1 text-[10px] uppercase tracking-[0.2em]">
            score
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#EF6E6E]">
                {event.eventTypeLabel}
              </p>
              <h3 className="mt-1 truncate text-base font-semibold text-white">
                {event.eventCauseLabel}
              </h3>
            </div>
            <p className="mono-data text-xs text-[#C1C7D0]">
              {Math.round(event.closureProb * 100)}% risk
            </p>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full border border-[#2C3139] bg-[#1D2128] px-2.5 py-1 text-[11px] text-[#D7DEE9]">
              {event.corridor}
            </span>
            {event.hotspotCount > 1 && (
              <span className="rounded-full border border-[#2C3139] bg-[#1D2128] px-2.5 py-1 text-[11px] text-[#D7DEE9]">
                {event.hotspotCount} hotspots
              </span>
            )}
            <span className="rounded-full border border-[#2C3139] bg-[#1D2128] px-2.5 py-1 text-[11px] text-[#D7DEE9]">
              {event.manpower} personnel
            </span>
            <span className="rounded-full border border-[#2C3139] bg-[#1D2128] px-2.5 py-1 text-[11px] text-[#D7DEE9]">
              {event.barricades} barricades
            </span>
          </div>

          <p className="mt-2 text-sm leading-6 text-[#9BA6B7]">{summaryLine}</p>
        </div>
      </div>
    </button>
  );
}

function RadialGauge({ label, value, percent, accent, footnote }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const progress = clamp(percent, 0, 1);
  const offset = circumference * (1 - progress);

  return (
    <div className="rounded-[20px] border border-[#262A31] bg-[#171A1F] px-4 py-4">
      <div className="mx-auto flex h-[120px] w-[120px] items-center justify-center">
        <svg viewBox="0 0 96 96" className="h-[110px] w-[110px]">
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            stroke="#2A2F38"
            strokeWidth="8"
          />
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            stroke={accent}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 48 48)"
          />
        </svg>
        <div className="absolute text-center">
          <p className="mono-data text-2xl font-semibold text-white">{value}</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-[#7B8494]">
            {Math.round(progress * 100)}% load
          </p>
        </div>
      </div>
      <p className="mt-2 text-center text-base font-semibold text-white">
        {label}
      </p>
      <p className="mt-1 text-center text-xs leading-5 text-[#97A2B3]">
        {footnote}
      </p>
    </div>
  );
}

function OverviewPanel({
  compact = false,
  uniqueDates,
  safeDateIndex,
  selectedDate,
  selectedHour,
  hourEvents,
  dayEvents,
  currentQueue,
  dayDelta,
  selectedDayPeak,
  dayManpower,
  dayBarricades,
  dayDiversions,
  dayPatrolMinutes,
  onPrevDay,
  onNextDay,
  onJumpBusiestDay,
  onDateSliderChange,
}) {
  return (
    <section
      className={`dashboard-panel px-4 py-4 ${
        compact ? "flex h-full min-h-0 flex-col" : ""
      }`}
    >
      <SectionHeader title="Tactical Overview" />

      <div
        className={`${
          compact
            ? "dashboard-scroll mt-3 min-h-0 flex-1 space-y-4 pr-1"
            : "mt-3 space-y-4"
        }`}
      >
        <div className="rounded-[18px] border border-[#262A31] bg-[#16191E] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-[#7B8494]">
                Operation Day
              </p>
              <p className="mono-data mt-1 text-lg font-semibold text-white">
                {formatDateLabel(selectedDate)}
              </p>
              <p className="mt-1 text-xs text-[#97A2B3]">
                {dayEvents.length} incidents, {dayDelta >= 0 ? "+" : ""}
                {dayDelta}% vs Bengaluru daily average
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPrevDay}
                className="icon-chip"
                aria-label="Previous day"
              >
                <Icon path="m15 18-6-6 6-6" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onNextDay}
                className="icon-chip"
                aria-label="Next day"
              >
                <Icon path="m9 18 6-6-6-6" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onJumpBusiestDay}
                className="rounded-full border border-[#334155] bg-[#101318] px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-[#D2D8E2]"
              >
                Peak day
              </button>
            </div>
          </div>

          <input
            type="range"
            min="0"
            max={Math.max(0, uniqueDates.length - 1)}
            value={safeDateIndex}
            onChange={onDateSliderChange}
            className="day-range mt-4 w-full"
            aria-label="Operation date"
          />

          <div className="mt-2 flex justify-between text-[10px] uppercase tracking-[0.18em] text-[#6F7888]">
            <span>{formatDateLabel(uniqueDates[0])}</span>
            <span>{formatDateLabel(uniqueDates[uniqueDates.length - 1])}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <KpiTile
            label="Hour Slice"
            value={String(hourEvents.length)}
            detail={`${formatHour(selectedHour)} • ${selectedDayPeak?.count || 0} peak-hour daily max`}
            accent="#EF4444"
          />
          <KpiTile
            label="Avg Impact"
            value={averageBy(hourEvents, (event) => event.impactScore).toFixed(
              2,
            )}
            detail={
              currentQueue.length
                ? `Queue tops out at ${currentQueue[0].impactScore.toFixed(2)}`
                : "No incidents in the selected hour"
            }
            accent="#F59E0B"
          />
          <KpiTile
            label="Closure Risk"
            value={`${Math.round(averageBy(hourEvents, (event) => event.closureProb) * 100)}%`}
            detail={`${hourEvents.filter((event) => event.closureProb >= 0.5).length} incidents above 50%`}
            accent="#EF4444"
          />
          <KpiTile
            label="Predicted Duration"
            value={`${averageBy(hourEvents, (event) => event.predictedDurationHours).toFixed(1)}h`}
            detail="Mean modeled clearance window"
            accent="#10B981"
          />
          <KpiTile
            label="Daily Manpower"
            value={String(dayManpower)}
            detail={`${dayDiversions} diversions across the selected day`}
            accent="#10B981"
          />
          <KpiTile
            label="Daily Barricades"
            value={String(dayBarricades)}
            detail={`${Math.round(dayPatrolMinutes || 0)} min patrol cadence`}
            accent="#10B981"
          />
        </div>
      </div>
    </section>
  );
}

function IncidentQueuePanel({
  compact = false,
  currentQueue,
  selectedEventId,
  onIncidentSelect,
}) {
  return (
    <section
      className={`dashboard-panel flex min-h-0 flex-col px-4 py-4 ${
        compact ? "h-full" : "flex-1"
      }`}
    >
      <SectionHeader title="Current Priority Incidents" />

      <div className="dashboard-scroll mt-4 flex-1 space-y-3 pr-1">
        {currentQueue.length ? (
          currentQueue.map((event) => (
            <IncidentCard
              key={event.id}
              event={event}
              active={selectedEventId === event.id}
              onSelect={onIncidentSelect}
            />
          ))
        ) : (
          <div className="rounded-[18px] border border-dashed border-[#2A2E35] bg-[#15181D] p-4 text-sm leading-6 text-[#97A2B3]">
            No incidents are logged in the selected hour. Scrub the timeline or
            step to another operation day to populate the tactical queue.
          </div>
        )}
      </div>
    </section>
  );
}

function ResourcePanel({
  compact = false,
  hourEvents,
  dominantCause,
  namedZoneCount,
  topCorridor,
  dayManpower,
  dayBarricades,
  dayDiversions,
  dayPatrolMinutes,
  dayPlannedShare,
  dayManpowerLoad,
  dayBarricadeLoad,
}) {
  return (
    <section
      className={`dashboard-panel px-4 py-4 ${
        compact ? "flex h-full min-h-0 flex-col" : ""
      }`}
    >
      <SectionHeader title="Resource Deployment" />

      <div
        className={`${
          compact
            ? "dashboard-scroll mt-4 min-h-0 flex-1 space-y-4 pr-1"
            : "mt-4 space-y-4"
        }`}
      >
        <div className="grid grid-cols-2 gap-3">
          <RadialGauge
            label="Manpower Load"
            value={dayManpower}
            percent={dayManpowerLoad}
            accent="#10B981"
            footnote={`${dayDiversions} diversions, ${Math.round(dayPatrolMinutes || 0)} min cadence`}
          />
          <RadialGauge
            label="Barricade Load"
            value={dayBarricades}
            percent={dayBarricadeLoad}
            accent="#64748B"
            footnote={`${hourEvents.length} incidents in the active hour slice`}
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-[16px] border border-[#262A31] bg-[#171A1F] px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[#7B8494]">
              Planned Share
            </p>
            <p className="mono-data mt-2 text-lg font-semibold text-white">
              {dayPlannedShare}%
            </p>
          </div>
          <div className="rounded-[16px] border border-[#262A31] bg-[#171A1F] px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[#7B8494]">
              Key Corridor
            </p>
            <p className="mt-2 text-sm font-semibold leading-5 text-white">
              {topCorridor?.label || "No corridor"}
            </p>
          </div>
          <div className="rounded-[16px] border border-[#262A31] bg-[#171A1F] px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[#7B8494]">
              Zone Tags
            </p>
            <p className="mono-data mt-2 text-lg font-semibold text-white">
              {namedZoneCount}
            </p>
          </div>
        </div>

        <div className="rounded-[16px] border border-[#262A31] bg-[#171A1F] px-3 py-3 text-sm leading-6 text-[#97A2B3]">
          <span className="font-semibold text-white">
            {dominantCause?.label || "No dominant cause"}
          </span>{" "}
          is the leading incident type on this day, shaping the resource posture
          and corridor pressure pattern.
        </div>
      </div>
    </section>
  );
}

function HeatLayer({ events, metric }) {
  const map = useMap();

  useEffect(() => {
    const heatLayer = L.heatLayer(
      events.map((event) => [
        event.latitude,
        event.longitude,
        getHeatWeight(event, metric),
      ]),
      {
        radius: 28,
        blur: 22,
        maxZoom: 15,
        minOpacity: 0.35,
        gradient: {
          0.15: "#16a34a",
          0.45: "#84cc16",
          0.7: "#f59e0b",
          1.0: "#ef4444",
        },
      },
    );

    heatLayer.addTo(map);
    return () => {
      map.removeLayer(heatLayer);
    };
  }, [events, map, metric]);

  return null;
}

function MapFocusController({ selectedEvent, markerRefs }) {
  const map = useMap();
  const selectedEventId = selectedEvent?.id || null;
  const selectedLatitude = selectedEvent?.latitude || null;
  const selectedLongitude = selectedEvent?.longitude || null;

  useEffect(() => {
    if (
      !selectedEventId ||
      selectedLatitude === null ||
      selectedLongitude === null
    ) {
      return undefined;
    }

    map.flyTo([selectedLatitude, selectedLongitude], 13, {
      duration: 0.8,
    });

    const timer = window.setTimeout(() => {
      markerRefs.current[selectedEventId]?.openPopup();
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [map, markerRefs, selectedEventId, selectedLatitude, selectedLongitude]);

  return null;
}

function MapLayoutController() {
  const map = useMap();

  useEffect(() => {
    const fitMap = () => {
      map.invalidateSize();
      map.setMaxBounds(BENGALURU_MAP_BOUNDS);
      map.fitBounds(BENGALURU_MAP_BOUNDS, {
        animate: false,
        padding: [28, 28],
      });
    };

    const firstPass = window.setTimeout(fitMap, 120);
    const secondPass = window.setTimeout(() => {
      map.invalidateSize();
    }, 520);

    window.addEventListener("resize", fitMap);

    return () => {
      window.clearTimeout(firstPass);
      window.clearTimeout(secondPass);
      window.removeEventListener("resize", fitMap);
    };
  }, [map]);

  return null;
}

function SidebarContent({
  compactDesktop = false,
  activePanel = "overview",
  onPanelChange,
  uniqueDates,
  safeDateIndex,
  selectedDate,
  selectedHour,
  hourEvents,
  dayEvents,
  currentQueue,
  selectedEventId,
  dayDelta,
  selectedDayPeak,
  dominantCause,
  namedZoneCount,
  topCorridor,
  dayManpower,
  dayBarricades,
  dayDiversions,
  dayPatrolMinutes,
  dayPlannedShare,
  dayManpowerLoad,
  dayBarricadeLoad,
  onIncidentSelect,
  onPrevDay,
  onNextDay,
  onJumpBusiestDay,
  onDateSliderChange,
}) {
  if (compactDesktop) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-3">
        <section className="dashboard-panel px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.28em] text-[#B6BDC9]">
                Tactical Views
              </p>
              <p className="mt-1 text-xs text-[#97A2B3]">
                Tuned for 16:9 command-center screens.
              </p>
            </div>
            <div className="mono-data rounded-full border border-[#2A2F38] bg-[#171A1F] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-[#D7DEE9]">
              {formatHour(selectedHour)}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <SidebarViewButton
              label="Overview"
              value={String(dayEvents.length)}
              active={activePanel === "overview"}
              onClick={() => onPanelChange("overview")}
            />
            <SidebarViewButton
              label="Queue"
              value={String(currentQueue.length)}
              active={activePanel === "queue"}
              onClick={() => onPanelChange("queue")}
            />
            <SidebarViewButton
              label="Resources"
              value={String(dayManpower)}
              active={activePanel === "resources"}
              onClick={() => onPanelChange("resources")}
            />
          </div>
        </section>

        <div className="min-h-0 flex-1">
          {activePanel === "overview" && (
            <OverviewPanel
              compact
              uniqueDates={uniqueDates}
              safeDateIndex={safeDateIndex}
              selectedDate={selectedDate}
              selectedHour={selectedHour}
              hourEvents={hourEvents}
              dayEvents={dayEvents}
              currentQueue={currentQueue}
              dayDelta={dayDelta}
              selectedDayPeak={selectedDayPeak}
              dayManpower={dayManpower}
              dayBarricades={dayBarricades}
              dayDiversions={dayDiversions}
              dayPatrolMinutes={dayPatrolMinutes}
              onPrevDay={onPrevDay}
              onNextDay={onNextDay}
              onJumpBusiestDay={onJumpBusiestDay}
              onDateSliderChange={onDateSliderChange}
            />
          )}

          {activePanel === "queue" && (
            <IncidentQueuePanel
              compact
              currentQueue={currentQueue}
              selectedEventId={selectedEventId}
              onIncidentSelect={onIncidentSelect}
            />
          )}

          {activePanel === "resources" && (
            <ResourcePanel
              compact
              hourEvents={hourEvents}
              dominantCause={dominantCause}
              namedZoneCount={namedZoneCount}
              topCorridor={topCorridor}
              dayManpower={dayManpower}
              dayBarricades={dayBarricades}
              dayDiversions={dayDiversions}
              dayPatrolMinutes={dayPatrolMinutes}
              dayPlannedShare={dayPlannedShare}
              dayManpowerLoad={dayManpowerLoad}
              dayBarricadeLoad={dayBarricadeLoad}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <OverviewPanel
        uniqueDates={uniqueDates}
        safeDateIndex={safeDateIndex}
        selectedDate={selectedDate}
        selectedHour={selectedHour}
        hourEvents={hourEvents}
        dayEvents={dayEvents}
        currentQueue={currentQueue}
        dayDelta={dayDelta}
        selectedDayPeak={selectedDayPeak}
        dayManpower={dayManpower}
        dayBarricades={dayBarricades}
        dayDiversions={dayDiversions}
        dayPatrolMinutes={dayPatrolMinutes}
        onPrevDay={onPrevDay}
        onNextDay={onNextDay}
        onJumpBusiestDay={onJumpBusiestDay}
        onDateSliderChange={onDateSliderChange}
      />

      <IncidentQueuePanel
        currentQueue={currentQueue}
        selectedEventId={selectedEventId}
        onIncidentSelect={onIncidentSelect}
      />

      <ResourcePanel
        hourEvents={hourEvents}
        dominantCause={dominantCause}
        namedZoneCount={namedZoneCount}
        topCorridor={topCorridor}
        dayManpower={dayManpower}
        dayBarricades={dayBarricades}
        dayDiversions={dayDiversions}
        dayPatrolMinutes={dayPatrolMinutes}
        dayPlannedShare={dayPlannedShare}
        dayManpowerLoad={dayManpowerLoad}
        dayBarricadeLoad={dayBarricadeLoad}
      />
    </div>
  );
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
  const [isMobileSheetExpanded, setIsMobileSheetExpanded] = useState(false);
  const [isCompactDesktop, setIsCompactDesktop] = useState(false);
  const [activeDesktopPanel, setActiveDesktopPanel] = useState("overview");
  const markerRefs = useRef({});
  const selectedHourRef = useRef(6);
  const touchStartYRef = useRef(null);

  useEffect(() => {
    Papa.parse("/event_congestion_scored_output.csv", {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsedEvents = results.data
          .map((row, index) => parseEvent(row, index))
          .filter(Boolean);
        const bengaluruEvents = parsedEvents.filter((event) =>
          isWithinBounds(event.latitude, event.longitude, BENGALURU_MAP_BOUNDS),
        );

        if (!bengaluruEvents.length) {
          setError("No Bengaluru incidents were found in the scored output.");
          setLoading(false);
          return;
        }

        const uniqueDates = Array.from(
          new Set(bengaluruEvents.map((event) => event.dateString)),
        ).sort();
        const dailyCounts = buildDailyCounts(bengaluruEvents);
        const busiestDayEntry = Array.from(dailyCounts.entries()).sort(
          (left, right) => right[1] - left[1],
        )[0];
        const busiestDay = busiestDayEntry
          ? busiestDayEntry[0]
          : uniqueDates[0];
        const busiestDayEvents = bengaluruEvents.filter(
          (event) => event.dateString === busiestDay,
        );
        const busiestHour = buildGroupStats(
          busiestDayEvents,
          (event) => String(event.hour),
          { limit: 1 },
        )[0];
        const initialHour = busiestHour ? Number(busiestHour.label) : 6;

        selectedHourRef.current = initialHour;
        setEvents(bengaluruEvents);
        setSelectedDateIndex(Math.max(0, uniqueDates.indexOf(busiestDay)));
        setSelectedHour(initialHour);
        setLoading(false);
      },
      error: (parseError) => {
        setError(parseError.message || "Failed to read the traffic dataset.");
        setLoading(false);
      },
    });
  }, []);

  useEffect(() => {
    selectedHourRef.current = selectedHour;
  }, [selectedHour]);

  useEffect(() => {
    const syncViewportMode = () => {
      setIsCompactDesktop(
        window.innerWidth >= 1024 && window.innerHeight <= 1040,
      );
    };

    syncViewportMode();
    window.addEventListener("resize", syncViewportMode);

    return () => {
      window.removeEventListener("resize", syncViewportMode);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      return undefined;
    }

    const playback = window.setInterval(() => {
      const currentHour = selectedHourRef.current;
      if (currentHour >= 23) {
        setIsPlaying(false);
        return;
      }

      const nextHour = currentHour + 1;
      selectedHourRef.current = nextHour;
      startTransition(() => {
        setSelectedEventId(null);
        setSelectedHour(nextHour);
      });
    }, 850);

    return () => {
      window.clearInterval(playback);
    };
  }, [isPlaying]);

  const uniqueDates = Array.from(
    new Set(events.map((event) => event.dateString)),
  ).sort();
  const safeDateIndex = clamp(
    selectedDateIndex,
    0,
    Math.max(0, uniqueDates.length - 1),
  );
  const selectedDate = uniqueDates[safeDateIndex] || "";

  const selectedDayEvents = events.filter(
    (event) => event.dateString === selectedDate,
  );
  const hourEvents = selectedDayEvents.filter(
    (event) => event.hour === selectedHour,
  );
  const dailyCounts = buildDailyCounts(events);
  const dailyRollups = buildDailyRollups(events);
  const dailyMaxManpower = Math.max(
    ...Array.from(dailyRollups.values()).map((item) => item.manpower),
    1,
  );
  const dailyMaxBarricades = Math.max(
    ...Array.from(dailyRollups.values()).map((item) => item.barricades),
    1,
  );
  const busiestDayEntry = Array.from(dailyCounts.entries()).sort(
    (left, right) => right[1] - left[1],
  )[0];
  const busiestDayIndex = busiestDayEntry
    ? uniqueDates.indexOf(busiestDayEntry[0])
    : 0;
  const dayManpower = sumBy(selectedDayEvents, (event) => event.manpower);
  const dayBarricades = sumBy(selectedDayEvents, (event) => event.barricades);
  const dayDiversions = sumBy(
    selectedDayEvents,
    (event) => event.diversionRoutes,
  );
  const dayPatrolMinutes = averageBy(
    selectedDayEvents,
    (event) => event.patrolFrequencyMinutes,
  );
  const dayPlannedShare = selectedDayEvents.length
    ? Math.round(
        (selectedDayEvents.filter((event) => event.eventType === "planned")
          .length /
          selectedDayEvents.length) *
          100,
      )
    : 0;
  const dayManpowerLoad = dayManpower / dailyMaxManpower;
  const dayBarricadeLoad = dayBarricades / dailyMaxBarricades;
  const dayAverageCount = uniqueDates.length
    ? events.length / uniqueDates.length
    : 0;
  const dayDelta =
    dayAverageCount > 0
      ? Math.round(
          ((selectedDayEvents.length - dayAverageCount) / dayAverageCount) *
            100,
        )
      : 0;

  const dayCauseMix = buildGroupStats(
    selectedDayEvents,
    (event) => event.eventCauseLabel,
    { limit: 1 },
  );
  const dominantCause = dayCauseMix[0];
  const corridorWatch = buildGroupStats(
    selectedDayEvents.filter(
      (event) =>
        event.corridor !== "Unknown" && event.corridor !== "Non-corridor",
    ),
    (event) => event.corridor,
    { limit: 1, sortBy: "pressure" },
  );
  const topCorridor = corridorWatch[0];
  const namedZoneCount = new Set(
    selectedDayEvents
      .filter((event) => event.zone !== "Unknown")
      .map((event) => event.zone),
  ).size;

  const hourlyRhythm = HOURS.map((hour) => {
    const bucket = selectedDayEvents.filter((event) => event.hour === hour);
    return {
      hour,
      count: bucket.length,
      impact: averageBy(bucket, (event) => event.impactScore),
    };
  });

  const selectedDayPeak = [...hourlyRhythm].sort((left, right) => {
    return right.count - left.count || right.impact - left.impact;
  })[0];

  const timelineGradient = buildTimelineGradient(hourlyRhythm);
  const currentQueue = buildPriorityQueue(hourEvents, 4);
  const highlightedIds = currentQueue.map((event) => event.id);
  const selectedEvent =
    hourEvents.find((event) => event.id === selectedEventId) || null;
  const mapEvents = [...hourEvents].sort(
    (left, right) => left.impactScore - right.impactScore,
  );

  const changeDateBy = (offset) => {
    startTransition(() => {
      setSelectedEventId(null);
      setSelectedDateIndex((current) =>
        clamp(current + offset, 0, Math.max(0, uniqueDates.length - 1)),
      );
      setIsPlaying(false);
    });
  };

  const handleDateSliderChange = (event) => {
    startTransition(() => {
      setSelectedEventId(null);
      setSelectedDateIndex(Number(event.target.value));
      setIsPlaying(false);
    });
  };

  const handleHourChange = (event) => {
    const nextHour = Number(event.target.value);
    selectedHourRef.current = nextHour;
    startTransition(() => {
      setSelectedEventId(null);
      setSelectedHour(nextHour);
    });
  };

  const handleIncidentSelect = (event) => {
    setShowMarkers(true);
    setSelectedEventId(event.id);
    setIsMobileSheetExpanded(false);
    setActiveDesktopPanel("queue");
  };

  const handleSheetTouchStart = (event) => {
    touchStartYRef.current = event.touches[0].clientY;
  };

  const handleSheetTouchEnd = (event) => {
    if (touchStartYRef.current === null) {
      return;
    }

    const deltaY = event.changedTouches[0].clientY - touchStartYRef.current;
    if (deltaY < -30) {
      setIsMobileSheetExpanded(true);
    }
    if (deltaY > 30) {
      setIsMobileSheetExpanded(false);
    }
    touchStartYRef.current = null;
  };

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0A0A0A] px-6">
        <div className="dashboard-panel max-w-xl rounded-[24px] px-8 py-8 text-center">
          <p className="text-[11px] uppercase tracking-[0.28em] text-[#7B8494]">
            Loading traffic intelligence
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-white">
            Building the Bengaluru command center
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#97A2B3]">
            Reading scored Astram incidents, loading the dark map, and preparing
            the hour-by-hour congestion heat layers.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0A0A0A] px-6">
        <div className="dashboard-panel max-w-xl rounded-[24px] border border-[#3B1F1F] px-8 py-8 text-center">
          <p className="text-[11px] uppercase tracking-[0.28em] text-[#EF4444]">
            Dataset issue
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-white">
            The dashboard could not initialize
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#C6CCD7]">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0A0A0A] text-[#F8FAFC]">
      <header className="flex h-14 items-center justify-between border-b border-[#1F1F1F] bg-[#0D0F12] px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#252932] bg-[#15181D] text-sm font-semibold text-white">
            TP
          </div>
          <div>
            <p className="text-sm font-semibold text-white">
              Traffic Intelligence Dashboard
            </p>
            <p className="text-[11px] uppercase tracking-[0.2em] text-[#7B8494]">
              Bengaluru traffic operations
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 rounded-full border border-[#252932] bg-[#13161B] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-[#D2D8E2] sm:flex">
            <span className="h-2 w-2 rounded-full bg-[#10B981]" />
            Live demo
          </div>
          <button
            type="button"
            className="icon-chip"
            aria-label="Notifications"
          >
            <Icon path="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m2 0a2 2 0 1 1-4 0" />
          </button>
          <button type="button" className="icon-chip" aria-label="Help">
            <Icon path="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2.3-3 4M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </button>
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#252932] bg-[#1A1D22] text-sm font-semibold text-white">
            W
          </div>
        </div>
      </header>

      <div className="relative grid h-[calc(100vh-56px)] w-full lg:grid-cols-[64px_minmax(360px,30vw)_minmax(0,1fr)]">
        <aside className="hidden border-r border-[#1F1F1F] bg-[#0D0F12] lg:flex lg:flex-col lg:items-center lg:gap-3 lg:px-2 lg:py-3">
          <RailButton
            title="Overview"
            active
            iconPath="M3 10.5 12 3l9 7.5v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"
          />
          <RailButton title="Signals" iconPath="M4 19V5m8 14V9m8 10V13" />
          <RailButton
            title="Layers"
            iconPath="m12 3 9 5-9 5-9-5 9-5Zm0 10 9-5v8l-9 5-9-5V8l9 5Z"
          />
          <RailButton
            title="Settings"
            iconPath="M12 8.8A3.2 3.2 0 1 1 8.8 12 3.2 3.2 0 0 1 12 8.8Zm8.2 3.2-.9-.5a7.8 7.8 0 0 0-.4-1l.5-.9a1 1 0 0 0-.2-1.2l-1.6-1.6a1 1 0 0 0-1.2-.2l-.9.5a7.8 7.8 0 0 0-1-.4l-.5-.9a1 1 0 0 0-.9-.6h-2.2a1 1 0 0 0-.9.6l-.5.9a7.8 7.8 0 0 0-1 .4l-.9-.5a1 1 0 0 0-1.2.2L4.1 8.4a1 1 0 0 0-.2 1.2l.5.9a7.8 7.8 0 0 0-.4 1l-.9.5a1 1 0 0 0-.6.9v2.2a1 1 0 0 0 .6.9l.9.5c.1.3.2.7.4 1l-.5.9a1 1 0 0 0 .2 1.2l1.6 1.6a1 1 0 0 0 1.2.2l.9-.5c.3.1.7.2 1 .4l.5.9a1 1 0 0 0 .9.6h2.2a1 1 0 0 0 .9-.6l.5-.9c.3-.1.7-.2 1-.4l.9.5a1 1 0 0 0 1.2-.2l1.6-1.6a1 1 0 0 0 .2-1.2l-.5-.9c.1-.3.2-.7.4-1l.9-.5a1 1 0 0 0 .6-.9V13a1 1 0 0 0-.6-.9Z"
          />
          <div className="mt-auto w-full border-t border-[#1F1F1F] pt-3" />
          <RailButton
            title="Help"
            iconPath="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2.3-3 4M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </aside>

        <aside className="hidden min-h-0 border-r border-[#1F1F1F] bg-[#101215] lg:block">
          <SidebarContent
            compactDesktop={isCompactDesktop}
            activePanel={activeDesktopPanel}
            onPanelChange={setActiveDesktopPanel}
            uniqueDates={uniqueDates}
            safeDateIndex={safeDateIndex}
            selectedDate={selectedDate}
            selectedHour={selectedHour}
            hourEvents={hourEvents}
            dayEvents={selectedDayEvents}
            currentQueue={currentQueue}
            selectedEventId={selectedEventId}
            dayDelta={dayDelta}
            selectedDayPeak={selectedDayPeak}
            dominantCause={dominantCause}
            namedZoneCount={namedZoneCount}
            topCorridor={topCorridor}
            dayManpower={dayManpower}
            dayBarricades={dayBarricades}
            dayDiversions={dayDiversions}
            dayPatrolMinutes={dayPatrolMinutes}
            dayPlannedShare={dayPlannedShare}
            dayManpowerLoad={dayManpowerLoad}
            dayBarricadeLoad={dayBarricadeLoad}
            onIncidentSelect={handleIncidentSelect}
            onPrevDay={() => changeDateBy(-1)}
            onNextDay={() => changeDateBy(1)}
            onJumpBusiestDay={() => {
              startTransition(() => {
                setSelectedEventId(null);
                setSelectedDateIndex(Math.max(0, busiestDayIndex));
                setIsPlaying(false);
              });
            }}
            onDateSliderChange={handleDateSliderChange}
          />
        </aside>

        <main className="relative min-w-0 bg-[#0B0D10]">
          <MapContainer
            center={BENGALURU_CENTER}
            maxBounds={BENGALURU_MAP_BOUNDS}
            maxBoundsViscosity={1}
            zoom={11.4}
            minZoom={11.2}
            maxZoom={15}
            preferCanvas
            zoomControl={false}
            style={{ height: "100%", width: "100%" }}
            className="map-surface"
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution="&copy; OpenStreetMap contributors &copy; CARTO"
            />
            <ZoomControl position="topright" />
            <MapLayoutController />
            <HeatLayer events={hourEvents} metric={heatMetric} />
            <MapFocusController
              selectedEvent={selectedEvent}
              markerRefs={markerRefs}
            />

            {showMarkers &&
              mapEvents.map((event) => {
                const accent = SEVERITY_META[event.severity].color;
                const isPinned = highlightedIds.includes(event.id);

                return (
                  <CircleMarker
                    key={event.id}
                    ref={(node) => {
                      if (node) {
                        markerRefs.current[event.id] = node;
                      } else {
                        delete markerRefs.current[event.id];
                      }
                    }}
                    center={[event.latitude, event.longitude]}
                    radius={getMarkerRadius(event)}
                    fillColor={accent}
                    color="#F8FAFC"
                    weight={selectedEventId === event.id ? 2.4 : 1.1}
                    opacity={0.95}
                    fillOpacity={selectedEventId === event.id ? 0.96 : 0.82}
                    eventHandlers={{
                      click: () => {
                        setSelectedEventId(event.id);
                        setActiveDesktopPanel("queue");
                      },
                    }}
                  >
                    {isPinned && (
                      <Tooltip
                        permanent
                        direction="top"
                        offset={[0, -8]}
                        interactive={false}
                        className="incident-score-tooltip"
                      >
                        {event.impactScore.toFixed(2)}
                      </Tooltip>
                    )}

                    <Popup autoPanPadding={[24, 24]}>
                      <div className="min-w-[250px] space-y-3 p-1">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-[#8E98A8]">
                            {event.eventTypeLabel}
                          </p>
                          <h3 className="mt-1 text-base font-semibold text-white">
                            {event.eventCauseLabel}
                          </h3>
                          <p className="mono-data mt-1 text-xs text-[#9BA6B7]">
                            {event.readableDate} at {event.readableTime}
                          </p>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs text-[#D7DEE9]">
                          <div className="rounded-xl border border-[#262A31] bg-[#14181D] p-2">
                            <p className="text-[#7B8494]">Impact</p>
                            <p className="mono-data mt-1 font-semibold text-white">
                              {event.impactScore.toFixed(2)}
                            </p>
                          </div>
                          <div className="rounded-xl border border-[#262A31] bg-[#14181D] p-2">
                            <p className="text-[#7B8494]">Closure</p>
                            <p className="mono-data mt-1 font-semibold text-white">
                              {Math.round(event.closureProb * 100)}%
                            </p>
                          </div>
                          <div className="rounded-xl border border-[#262A31] bg-[#14181D] p-2">
                            <p className="text-[#7B8494]">Duration</p>
                            <p className="mono-data mt-1 font-semibold text-white">
                              {event.predictedDurationHours.toFixed(1)}h
                            </p>
                          </div>
                          <div className="rounded-xl border border-[#262A31] bg-[#14181D] p-2">
                            <p className="text-[#7B8494]">Manpower</p>
                            <p className="mono-data mt-1 font-semibold text-white">
                              {event.manpower}
                            </p>
                          </div>
                        </div>

                        <div className="space-y-1 text-xs leading-5 text-[#C7D0DD]">
                          <p>
                            <span className="font-semibold text-white">
                              Corridor:
                            </span>{" "}
                            {event.corridor}
                          </p>
                          <p>
                            <span className="font-semibold text-white">
                              Zone:
                            </span>{" "}
                            {event.zone}
                          </p>
                          <p>
                            <span className="font-semibold text-white">
                              Junction:
                            </span>{" "}
                            {event.junction}
                          </p>
                        </div>

                        <div className="rounded-xl border border-[#262A31] bg-[#14181D] p-3 text-xs leading-5 text-[#C7D0DD]">
                          <p className="font-semibold text-white">
                            Action note
                          </p>
                          <p className="mt-1">{event.actionNotes}</p>
                        </div>

                        <p className="text-xs leading-5 text-[#9BA6B7]">
                          {event.address}
                        </p>
                      </div>
                    </Popup>
                  </CircleMarker>
                );
              })}
          </MapContainer>

          <div className="pointer-events-none absolute inset-0 z-[450]">
            <div className="pointer-events-auto absolute left-4 top-4 max-w-[calc(100%-120px)] rounded-[18px] border border-[#252932] bg-[#111419]/96 px-4 py-3 shadow-[0_12px_32px_rgba(0,0,0,0.3)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#B6BDC9]">
                Bengaluru Heatmap
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="text-sm font-semibold text-white sm:text-base">
                  {
                    HEAT_OPTIONS.find((option) => option.id === heatMetric)
                      ?.label
                  }{" "}
                  density for {formatHour(selectedHour)}
                </h1>
                <span className="mono-data rounded-full border border-[#2A2F38] bg-[#171A1F] px-2.5 py-1 text-[11px] text-[#D7DEE9]">
                  {formatDateLabel(selectedDate)}
                </span>
              </div>
            </div>

            <div className="pointer-events-auto absolute right-4 top-4 flex flex-col gap-2">
              {HEAT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setHeatMetric(option.id)}
                  className={`toggle-stack-button ${
                    heatMetric === option.id ? "toggle-stack-button-active" : ""
                  }`}
                  title={`${option.label} heatmap`}
                >
                  <span className="mono-data text-sm font-semibold">
                    {option.short}
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.16em]">
                    {option.label}
                  </span>
                </button>
              ))}

              <button
                type="button"
                onClick={() => {
                  setSelectedEventId(null);
                  setShowMarkers((current) => !current);
                }}
                className={`toggle-stack-button ${
                  showMarkers ? "toggle-stack-button-active" : ""
                }`}
                title="Toggle markers"
              >
                <span className="mono-data text-sm font-semibold">P</span>
                <span className="text-[10px] uppercase tracking-[0.16em]">
                  Pins
                </span>
              </button>
            </div>

            {hourEvents.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center px-6">
                <div className="pointer-events-auto rounded-[20px] border border-[#252932] bg-[#111419]/96 px-5 py-4 text-center shadow-[0_12px_32px_rgba(0,0,0,0.34)]">
                  <p className="text-[11px] uppercase tracking-[0.28em] text-[#7B8494]">
                    Empty hour slice
                  </p>
                  <p className="mt-2 max-w-md text-sm leading-6 text-[#C7D0DD]">
                    No incidents were logged at {formatHour(selectedHour)} on{" "}
                    {formatDateLabel(selectedDate)}. Use the controller to step
                    through other hours or move the operation day.
                  </p>
                </div>
              </div>
            )}

            <div className="pointer-events-auto absolute bottom-4 left-1/2 w-[min(860px,calc(100%-1.5rem))] -translate-x-1/2">
              <div className="dashboard-panel rounded-[22px] bg-[#14181D]/94 px-4 py-4 shadow-[0_18px_40px_rgba(0,0,0,0.34)]">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#B6BDC9]">
                      Timeline Controller
                    </p>
                    <p className="mt-1 text-sm text-[#97A2B3]">
                      Scrub the active hour within the selected Bengaluru
                      operation day.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => changeDateBy(-1)}
                      className="icon-chip"
                      aria-label="Previous day"
                    >
                      <Icon path="m15 18-6-6 6-6" className="h-4 w-4" />
                    </button>
                    <div className="mono-data rounded-full border border-[#2A2F38] bg-[#171A1F] px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-[#D7DEE9]">
                      {formatDateLabel(selectedDate)} at{" "}
                      {formatHour(selectedHour)}
                    </div>
                    <button
                      type="button"
                      onClick={() => changeDateBy(1)}
                      className="icon-chip"
                      aria-label="Next day"
                    >
                      <Icon path="m9 18 6-6-6-6" className="h-4 w-4" />
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
                      className="rounded-full border border-[#334155] bg-[#101318] px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-[#D2D8E2]"
                    >
                      Busiest day
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedHour >= 23) {
                        selectedHourRef.current = 0;
                        setSelectedHour(0);
                      }
                      setIsPlaying((current) => !current);
                    }}
                    className="timeline-play-button"
                    aria-label={isPlaying ? "Pause playback" : "Play playback"}
                  >
                    {isPlaying ? (
                      <Icon
                        path="M8 6h3v12H8zm5 0h3v12h-3z"
                        className="h-4 w-4"
                      />
                    ) : (
                      <Icon path="m8 6 10 6-10 6z" className="h-4 w-4" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <input
                      type="range"
                      min="0"
                      max="23"
                      value={selectedHour}
                      onChange={handleHourChange}
                      className="timeline-range w-full"
                      style={{ backgroundImage: timelineGradient }}
                      aria-label="Selected hour"
                    />
                    <div className="mt-2 flex justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-[#7B8494]">
                      {HOURS.map((hour) => (
                        <span key={hour} className="mono-data">
                          {String(hour).padStart(2, "0")}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 text-xs text-[#97A2B3]">
                    <span>Intensity</span>
                    <div className="h-2 w-32 rounded-full bg-[linear-gradient(90deg,#16a34a_0%,#84cc16_35%,#f59e0b_70%,#ef4444_100%)]" />
                  </div>
                  <div className="flex items-center gap-4 text-xs text-[#97A2B3]">
                    <span>
                      {hourEvents.length} incidents in the active slice
                    </span>
                    <span>
                      Daily peak at{" "}
                      <span className="mono-data text-white">
                        {formatHour(selectedDayPeak?.hour || 0)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside
            className="absolute inset-x-0 bottom-0 z-[600] border-t border-[#1F1F1F] bg-[#101215]/96 shadow-[0_-18px_40px_rgba(0,0,0,0.4)] transition-transform duration-300 lg:hidden"
            style={{
              transform: isMobileSheetExpanded
                ? "translateY(0)"
                : "translateY(calc(100% - 92px))",
            }}
          >
            <div
              className="mobile-sheet-handle px-4 pt-3"
              onClick={() => setIsMobileSheetExpanded((current) => !current)}
              onTouchStart={handleSheetTouchStart}
              onTouchEnd={handleSheetTouchEnd}
              role="button"
              tabIndex={0}
            >
              <div className="mx-auto h-1.5 w-14 rounded-full bg-[#3A404A]" />
              <div className="mt-3 flex items-center justify-between gap-3 pb-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-[#7B8494]">
                    Tactical panel
                  </p>
                  <p className="mono-data mt-1 text-lg font-semibold text-white">
                    {formatDateLabel(selectedDate)} • {formatHour(selectedHour)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <span className="rounded-full border border-[#2A2F38] bg-[#171A1F] px-3 py-1 text-xs text-[#D7DEE9]">
                    {hourEvents.length} incidents
                  </span>
                  <span className="rounded-full border border-[#2A2F38] bg-[#171A1F] px-3 py-1 text-xs text-[#D7DEE9]">
                    {Math.round(
                      averageBy(hourEvents, (event) => event.closureProb) * 100,
                    )}
                    % risk
                  </span>
                </div>
              </div>
            </div>

            <div className="h-[min(72vh,680px)]">
              <SidebarContent
                onPanelChange={setActiveDesktopPanel}
                uniqueDates={uniqueDates}
                safeDateIndex={safeDateIndex}
                selectedDate={selectedDate}
                selectedHour={selectedHour}
                hourEvents={hourEvents}
                dayEvents={selectedDayEvents}
                currentQueue={currentQueue}
                selectedEventId={selectedEventId}
                dayDelta={dayDelta}
                selectedDayPeak={selectedDayPeak}
                dominantCause={dominantCause}
                namedZoneCount={namedZoneCount}
                topCorridor={topCorridor}
                dayManpower={dayManpower}
                dayBarricades={dayBarricades}
                dayDiversions={dayDiversions}
                dayPatrolMinutes={dayPatrolMinutes}
                dayPlannedShare={dayPlannedShare}
                dayManpowerLoad={dayManpowerLoad}
                dayBarricadeLoad={dayBarricadeLoad}
                onIncidentSelect={handleIncidentSelect}
                onPrevDay={() => changeDateBy(-1)}
                onNextDay={() => changeDateBy(1)}
                onJumpBusiestDay={() => {
                  startTransition(() => {
                    setSelectedEventId(null);
                    setSelectedDateIndex(Math.max(0, busiestDayIndex));
                    setIsPlaying(false);
                  });
                }}
                onDateSliderChange={handleDateSliderChange}
              />
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

export default App;
