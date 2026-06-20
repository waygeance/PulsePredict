import pandas as pd
import json
from datetime import datetime

# Read the CSV file
df = pd.read_csv('../Data/Astram event data_anonymized - Astram event data_anonymizedb40ac87.csv')

# Filter to only include events with valid coordinates
df = df[(df['latitude'].notna()) & (df['longitude'].notna()) & 
        (df['latitude'] != 0) & (df['longitude'] != 0)]

# Parse datetime
df['start_datetime'] = pd.to_datetime(df['start_datetime'], errors='coerce')
df = df[df['start_datetime'].notna()]

# Extract date and time components
df['date'] = df['start_datetime'].dt.strftime('%Y-%m-%d')
df['time'] = df['start_datetime'].dt.strftime('%H:%M')
df['hour'] = df['start_datetime'].dt.hour

# Select relevant columns for visualization
columns_to_keep = ['id', 'event_type', 'latitude', 'longitude', 'address', 
                   'event_cause', 'requires_road_closure', 'start_datetime',
                   'date', 'time', 'hour', 'status', 'priority']

df_filtered = df[columns_to_keep].copy()

# Convert to JSON
events_data = df_filtered.to_dict(orient='records')

# Get unique dates and hours for sliders
unique_dates = sorted(df_filtered['date'].unique())
date_range = {
    'start': unique_dates[0] if unique_dates else None,
    'end': unique_dates[-1] if unique_dates else None,
    'all_dates': unique_dates
}

# Save to JSON files
with open('public/events_data.json', 'w') as f:
    json.dump(events_data, f, indent=2, default=str)

with open('public/date_range.json', 'w') as f:
    json.dump(date_range, f, indent=2)

print(f"Processed {len(events_data)} events")
print(f"Date range: {date_range['start']} to {date_range['end']}")
print(f"Total unique dates: {len(unique_dates)}")
