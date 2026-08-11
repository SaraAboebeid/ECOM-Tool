import { CommunityDefinition } from '../api/community';

/**
 * Moving the dispatched window to an arbitrary day of 2022 or 2023.
 *
 * The year is not part of AnalysisPeriodSpec - that describes a slice of a
 * generic 8760-hour year - so it lives in each building's `csv_path`, which
 * points at a year-specific file (`..._2022.csv`). Changing year therefore
 * means repointing those paths, and changing day means rewriting the period.
 *
 * Both 2022 and 2023 are non-leap years, so the toolkit's fixed 8760-hour year
 * holds and no leap day has to be special-cased.
 */
export const AVAILABLE_YEARS = [2022, 2023] as const;
export type AvailableYear = (typeof AVAILABLE_YEARS)[number];

export const MIN_DATE = '2022-01-01';
export const MAX_DATE = '2023-12-31';

/** Which year the definition currently reads, taken from its demand paths. */
export const yearOf = (definition: CommunityDefinition): AvailableYear => {
  for (const building of definition.buildings ?? []) {
    const path = building.demand?.csv_path;
    const match = path?.match(/_(\d{4})\.csv$/i);
    if (match) {
      const year = Number(match[1]);
      if ((AVAILABLE_YEARS as readonly number[]).includes(year)) {
        return year as AvailableYear;
      }
    }
  }
  return AVAILABLE_YEARS[0];
};

/** The day the definition currently dispatches, as an ISO yyyy-mm-dd string. */
export const dayOf = (definition: CommunityDefinition): string => {
  const period = definition.analysis_period ?? {};
  const year = yearOf(definition);
  const month = period.start_month ?? 1;
  const day = period.start_day ?? 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * Retarget the definition at a single day.
 *
 * One day rather than the whole year deliberately: dispatch cost scales with
 * the window, and 24 hours keeps the slider responsive. Scrubbing across years
 * is then a matter of moving the window, not of dispatching 17,520 hours.
 */
export const setAnalysisDay = (
  definition: CommunityDefinition,
  isoDate: string,
): CommunityDefinition => {
  const [yearText, monthText, dayText] = isoDate.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!year || !month || !day) return definition;

  const next: CommunityDefinition = {
    ...definition,
    analysis_period: {
      start_month: month,
      start_day: day,
      start_hour: 0,
      end_month: month,
      end_day: day,
      end_hour: 23,
    },
    buildings: definition.buildings.map((building) => {
      const path = building.demand?.csv_path;
      if (!path) return building;
      // Only rewrite a year we actually have files for; anything else is left
      // alone so a hand-edited path is not silently broken.
      const retargeted = path.replace(
        /_(\d{4})\.csv$/i,
        (whole, found) =>
          (AVAILABLE_YEARS as readonly number[]).includes(Number(found))
            ? `_${year}.csv`
            : whole,
      );
      if (retargeted === path) return building;
      return { ...building, demand: { ...building.demand, csv_path: retargeted } };
    }),
  };

  return next;
};

/** Step the window by whole days, clamped to the data we hold. */
export const shiftDay = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const iso = date.toISOString().slice(0, 10);
  if (iso < MIN_DATE) return MIN_DATE;
  if (iso > MAX_DATE) return MAX_DATE;
  return iso;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Tue 11 Aug 2022' - short, and the weekday matters for demand patterns. */
export const formatDay = (isoDate: string): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ` +
         `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};
