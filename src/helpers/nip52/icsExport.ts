/**
 * ICS export for NIP-52 calendar events (RFC 5545).
 * Pure builder + download helper. Kind 31922 exports as all-day (DTSTART;VALUE=DATE),
 * kind 31923 as timed UTC (DTSTART/DTEND in basic UTC format).
 */

import type { CalendarEventData } from './parser';

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function foldLine(line: string): string {
  // RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF + space.
  if (line.length <= 74) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 0) {
    chunks.push(` ${rest.slice(0, 73)}`);
    rest = rest.slice(73);
  }
  return chunks.join('\r\n');
}

export function calendarEventToICS(event: CalendarEventData): string {
  const uid = event.coordinate;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NoorNote//Calendar Addon//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${icsTimestamp(event.createdAt * 1000 || Date.now())}`,
  ];

  if (event.allDay) {
    const start = new Date(event.startMs)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    if (event.endMs !== null) {
      const end = new Date(event.endMs)
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, '');
      lines.push(`DTEND;VALUE=DATE:${end}`);
    }
  } else {
    lines.push(`DTSTART:${icsTimestamp(event.startMs)}`);
    if (event.endMs !== null) lines.push(`DTEND:${icsTimestamp(event.endMs)}`);
  }

  lines.push(`SUMMARY:${icsEscape(event.title || '(Untitled event)')}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
  }
  if (event.locations.length > 0) {
    lines.push(`LOCATION:${icsEscape(event.locations.join(', '))}`);
  }
  for (const link of event.links) {
    lines.push(`URL:${icsEscape(link)}`);
  }
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Trigger a `.ics` download in the browser/Electron renderer. */
export function downloadCalendarEventICS(event: CalendarEventData): void {
  const blob = new Blob([calendarEventToICS(event)], {
    type: 'text/calendar;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const slug =
    (event.title || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'event';
  anchor.download = `${slug}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
