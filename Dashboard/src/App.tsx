import { useState, useEffect, useMemo, useRef, ReactNode } from 'react';
import { Graph } from './components/Graph/';
import { Timeline } from './components/Timeline';
import { Legend } from './components/Legend';
import { DashboardHeader } from './components/DashboardHeader';

import { SankeyDrawer } from './components/SankeyDrawer';
import { CommunityControls } from './components/CommunityControls';
import { OptimizationPanel } from './components/OptimizationPanel';
import { ConsoleRail } from './components/ConsoleRail';
import { ConsolePanel } from './components/ui/ConsolePanel';
import { MembersPanel } from './components/MembersPanel';
import { SizingPanel } from './components/SizingPanel';
import { ParametersPanel } from './components/ParametersPanel';
import { GraphData } from './types';
import { COMPASS_ORIENTATION } from './utils/backgroundConfig';
import {
  ApiError,
  CommunityDefinition,
  DEFAULT_COMMUNITY,
  DEMO_SCENARIO,
  ScenarioSummary,
  dispatchCommunity,
  listScenarios,
  loadScenario,
} from './api/community';

/** A dispatch takes ~2 s, so wait for the slider to settle before asking. */
const DISPATCH_DEBOUNCE_MS = 400;

function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const [currentHour, setCurrentHour] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(['building', 'pv', 'grid', 'battery', 'charge_point']));
  const [activeOwners, setActiveOwners] = useState<Set<string>>(new Set());
  const [v2gFilter, setV2gFilter] = useState<'all' | 'v2g-only' | 'no-v2g'>('all');
  const [capacityRange, setCapacityRange] = useState<{ min: number; max: number }>({ min: 0, max: 1000 });
  const [minFlow, setMinFlow] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [fitToViewFn, setFitToViewFn] = useState<(() => void) | null>(null);
  const [isSankeyOpen, setIsSankeyOpen] = useState(false);
  const [definition, setDefinition] = useState<CommunityDefinition>(DEFAULT_COMMUNITY);
  const [isComputing, setIsComputing] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ period: string; hours: number } | null>(null);
  // Owners are seeded from the first successful response only; re-seeding on
  // every dispatch would reset the user's filter selection mid-session.
  const ownersSeeded = useRef(false);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([DEMO_SCENARIO]);
  const [activeScenario, setActiveScenario] = useState<string>(DEMO_SCENARIO.name);
  // Buildings taken out of the community. Held separately so they can be
  // restored; dropping them from `definition` alone would lose their spec.
  const [excludedBuildings, setExcludedBuildings] = useState<Record<string, unknown>>({});
  // Only the parameters the user actually changed. Anything absent keeps
  // LEC-Opt's committed default, so an empty object reproduces the model as
  // the optimization team runs it.
  const [optimizerParams, setOptimizerParams] = useState<Record<string, number>>({});

  // Saved definitions live on the backend; the built-in demo stays first so
  // there is always something to fall back to if the API is unreachable.
  useEffect(() => {
    listScenarios()
      .then((found) => {
        setScenarios([DEMO_SCENARIO, ...found]);
        // Prefer a real campus over the demo on first load.
        const campus = found.find((s) => s.name.startsWith('campus'));
        if (campus) {
          setActiveScenario(campus.name);
        }
      })
      .catch(() => setScenarios([DEMO_SCENARIO]));
  }, []);

  useEffect(() => {
    if (activeScenario === DEMO_SCENARIO.name) {
      setDefinition(DEFAULT_COMMUNITY);
      return;
    }
    let cancelled = false;
    loadScenario(activeScenario)
      .then((loaded) => {
        if (cancelled) return;
        ownersSeeded.current = false;   // re-seed filters for the new community
        setExcludedBuildings({});       // exclusions belong to the old community
        setDefinition(loaded);
      })
      .catch((err) => {
        if (!cancelled) setDispatchError(String(err.message ?? err));
      });
    return () => { cancelled = true; };
  }, [activeScenario]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setIsComputing(true);
      dispatchCommunity(definition, controller.signal)
        .then((response) => {
          setData(response);
          setMeta({ period: response.meta.period, hours: response.meta.hours });
          setDispatchError(null);

          if (!ownersSeeded.current) {
            ownersSeeded.current = true;
            const owners = new Set<string>();
            response.nodes.forEach((node: any) => {
              if (node.owner) owners.add(node.owner);
              if (Array.isArray(node.VALID_OWNERS)) {
                node.VALID_OWNERS.forEach((o: string) => owners.add(o));
              }
            });
            setActiveOwners(owners);

            const capacities = response.nodes
              .map((n: any) => n.capacity || n.installed_capacity || 0)
              .filter((c: number) => c > 0);
            if (capacities.length > 0) {
              setCapacityRange({
                min: 0,
                max: Math.ceil(Math.max(...capacities) / 10) * 10,
              });
            }
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;   // superseded by a newer edit
          setDispatchError(
            err instanceof ApiError
              ? err.message
              : 'Could not reach the backend. Start it with:\n' +
                'cd backend && python -m uvicorn app.main:app --reload --port 8000',
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsComputing(false);
        });
    }, DISPATCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [definition]);

  useEffect(() => {
    // Check localStorage first, then system preference
    const storedTheme = localStorage.getItem('theme');
    
    if (storedTheme) {
      setIsDarkMode(storedTheme === 'dark');
      document.documentElement.classList.toggle('dark', storedTheme === 'dark');
    } else {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const isDark = mediaQuery.matches;
      setIsDarkMode(isDark);
      document.documentElement.classList.toggle('dark', isDark);
    }

    // Listen for system preference changes
    const handler = (e: MediaQueryListEvent) => {
      // Only update if no theme is stored in localStorage
      if (!localStorage.getItem('theme')) {
        setIsDarkMode(e.matches);
        document.documentElement.classList.toggle('dark', e.matches);
      }
    };
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  const toggleDarkMode = () => {
    // 1. First update the state (this doesn't cause immediate DOM updates)
    const newDarkMode = !isDarkMode;
    setIsDarkMode(newDarkMode);
    
    // 2. Schedule DOM updates for the next frame
    requestAnimationFrame(() => {
      // Add a class that will temporarily disable transitions
      document.documentElement.classList.add('disable-transitions');
      
      // Toggle dark mode class
      document.documentElement.classList.toggle('dark', newDarkMode);
      
      // Save preference to localStorage
      localStorage.setItem('theme', newDarkMode ? 'dark' : 'light');
      
      // Force a reflow to ensure disable-transitions takes effect
      document.documentElement.scrollTop;
      
      // Remove the class that disables transitions after the update
      requestAnimationFrame(() => {
        document.documentElement.classList.remove('disable-transitions');
      });
    });
  };

  const toggleNodeType = (type: string) => {
    const newTypes = new Set(activeTypes);
    if (newTypes.has(type)) {
      newTypes.delete(type);
    } else {
      newTypes.add(type);
    }
    setActiveTypes(newTypes);
  };

  const toggleOwner = (owner: string) => {
    const newOwners = new Set(activeOwners);
    if (newOwners.has(owner)) {
      newOwners.delete(owner);
    } else {
      newOwners.add(owner);
    }
    setActiveOwners(newOwners);
  };

  const handleV2gFilterChange = (filter: 'all' | 'v2g-only' | 'no-v2g') => {
    setV2gFilter(filter);
  };

  const handleCapacityRangeChange = (range: { min: number; max: number }) => {
    setCapacityRange(range);
  };

  const togglePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  const handleFitToView = (fitFn: () => void) => {
    setFitToViewFn(() => fitFn);
  };

  const onFitToViewClick = () => {
    if (fitToViewFn) {
      fitToViewFn();
    }
  };

  const filters = useMemo(() => ({
    nodeTypes: activeTypes,
    minFlow,
    owners: activeOwners,
    v2gFilter,
    capacityRange
  }), [activeTypes, minFlow, activeOwners, v2gFilter, capacityRange]);

  // Shrinking the period can leave the timeline past the end of the new flows.
  useEffect(() => {
    if (meta && currentHour >= meta.hours) {
      setCurrentHour(Math.max(0, meta.hours - 1));
    }
  }, [meta, currentHour]);

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        {dispatchError ? (
          <div className="max-w-lg p-4 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200">
            <p className="font-semibold mb-2">The first dispatch failed</p>
            <pre className="text-xs whitespace-pre-wrap font-mono">{dispatchError}</pre>
          </div>
        ) : (
          <>
            <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500" />
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Dispatching the community…
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden contain-layout dashboard-shell text-gray-900 dark:text-gray-100">
      <div className="h-full flex">
        <main className="flex-1 min-w-0 flex flex-col">
          <DashboardHeader data={data} currentHour={currentHour} />

          <div className="flex-1 min-h-0 px-4 pb-4 pt-2">
            <div className="workspace-card h-full">
              <div className="workspace-grid h-full">
                <div className="workspace-console min-h-0">
                  <ConsoleRail>
                    <ConsolePanel
                      title="Scenario"
                      subtitle={`${definition.buildings?.length ?? 0} buildings`}
                      status={dispatchError ? 'error' : isComputing ? 'busy' : 'ok'}
                      defaultOpen
                      maxBodyHeight={340}
                    >
                      <CommunityControls
                        definition={definition}
                        onChange={setDefinition}
                        isComputing={isComputing}
                        error={dispatchError}
                        meta={meta}
                        scenarios={scenarios}
                        activeScenario={activeScenario}
                        onScenarioChange={setActiveScenario}
                      />
                    </ConsolePanel>

                    <ConsolePanel
            title="Members"
            subtitle={`${definition.buildings.length} buildings`}
            defaultOpen
            maxBodyHeight={440}
          >
            <MembersPanel
              definition={definition}
              onChange={setDefinition}
              excluded={excludedBuildings}
              onExcludedChange={setExcludedBuildings}
            />
          </ConsolePanel>

          <ConsolePanel title="Filters" subtitle={`${activeTypes.size} types`}>
                      <Legend
                        activeTypes={activeTypes}
                        onToggleType={toggleNodeType}
                        minFlow={minFlow}
                        onMinFlowChange={setMinFlow}
                        activeOwners={activeOwners}
                        onToggleOwner={toggleOwner}
                        availableOwners={data ? [...new Set(data.nodes.flatMap(n => {
                          const owners: string[] = [];
                          if (n.owner) owners.push(n.owner);
                          if (n.VALID_OWNERS && Array.isArray(n.VALID_OWNERS)) {
                            owners.push(...n.VALID_OWNERS);
                          }
                          return owners;
                        }))] : []}
                        v2gFilter={v2gFilter}
                        onV2gFilterChange={handleV2gFilterChange}
                        capacityRange={capacityRange}
                        onCapacityRangeChange={handleCapacityRangeChange}
                        maxCapacity={data ? Math.max(...data.nodes.map(n => n.capacity || n.installed_capacity || 0)) : 100}
                      />
                    </ConsolePanel>

                    <ConsolePanel title="Optimization" subtitle="LEC-Opt" maxBodyHeight={380}>
                      <OptimizationPanel
                        definition={definition}
                        parameters={optimizerParams}
                      />
                    </ConsolePanel>

                    <ConsolePanel title="Sizing" subtitle="cost curve" maxBodyHeight={470}>
                      <SizingPanel
                        definition={definition}
                        parameters={optimizerParams}
                      />
                    </ConsolePanel>

                    <ConsolePanel
                      title="Parameters"
                      subtitle={
                        Object.keys(optimizerParams).length
                          ? `${Object.keys(optimizerParams).length} changed`
                          : 'defaults'
                      }
                      maxBodyHeight={440}
                    >
                      <ParametersPanel
                        value={optimizerParams}
                        onChange={setOptimizerParams}
                      />
                    </ConsolePanel>
                  </ConsoleRail>
                </div>

                <div className="workspace-main min-h-0">
                  <div className="relative viewer-shell flex-1 min-h-[420px] rounded-2xl overflow-hidden border border-slate-200/70 dark:border-slate-700/70">
                    <div className="absolute top-4 right-4 flex gap-2 z-50">
                      <button
                        onClick={onFitToViewClick}
                        disabled={!fitToViewFn}
                        className="viewer-fab disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Fit graph to view"
                        title="Fit graph to view"
                      >
                        <FitToViewIcon className="w-5 h-5 text-slate-700 dark:text-slate-200" />
                      </button>

                      <div
                        className="viewer-fab cursor-default flex items-center justify-center"
                        title={`Compass orientation: ${COMPASS_ORIENTATION}° clockwise`}
                      >
                        <CompassIcon
                          className="w-5 h-5 text-slate-700 dark:text-slate-200"
                          rotation={COMPASS_ORIENTATION}
                        />
                      </div>

                      <button
                        onClick={toggleDarkMode}
                        className="viewer-fab"
                        aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
                        title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
                      >
                        {isDarkMode ? (
                          <SunIcon className="w-5 h-5 text-amber-500" />
                        ) : (
                          <MoonIcon className="w-5 h-5 text-slate-700" />
                        )}
                      </button>
                    </div>

                    <Graph
                      data={data}
                      currentHour={currentHour}
                      filters={filters}
                      isTimelinePlaying={isPlaying}
                      onFitToView={handleFitToView}
                    />
                  </div>

                  <div className="relative mt-3">
                    <button
                      onClick={() => setIsSankeyOpen(!isSankeyOpen)}
                      className="absolute left-1/2 -translate-x-1/2 -top-9 bg-blue-500 dark:bg-blue-600 text-white rounded-xl px-4 py-2 text-sm font-medium shadow-md z-50 hover:bg-blue-600 dark:hover:bg-blue-700 transition-colors"
                    >
                      {isSankeyOpen ? 'Hide' : 'Show'} Energy Flow Diagram
                    </button>
                    <Timeline
                      currentHour={currentHour}
                      isPlaying={isPlaying}
                      onHourChange={setCurrentHour}
                      onPlayPause={togglePlayPause}
                      isSankeyOpen={isSankeyOpen}
                      totalHours={meta?.hours ?? 48}
                      embedded
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {data && (
        <SankeyDrawer
          isOpen={isSankeyOpen}
          onClose={() => setIsSankeyOpen(false)}
          data={data}
          currentHour={currentHour}
          isDarkMode={isDarkMode}
        />
      )}
    </div>
  );
}

const SunIcon = ({ className = "w-6 h-6" }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
    />
  </svg>
);

const MoonIcon = ({ className = "w-6 h-6" }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
    />
  </svg>
);

const FitToViewIcon = ({ className = "w-6 h-6" }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"
    />
  </svg>
);

const CompassIcon = ({ className = "w-6 h-6", rotation = 0 }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    style={{ transform: `rotate(${rotation}deg)` }}
  >
    {/* Compass circle */}
    <circle
      cx="12"
      cy="12"
      r="10"
      strokeWidth={2}
    />
    {/* North arrow */}
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 2 L16 8 L12 6 L8 8 Z"
      fill="currentColor"
    />
    {/* Center dot */}
    <circle
      cx="12"
      cy="12"
      r="1"
      fill="currentColor"
    />
    {/* N marker */}
    <text
      x="12"
      y="5"
      fontSize="8"
      textAnchor="middle"
      fill="currentColor"
      fontWeight="bold"
    >
      N
    </text>
  </svg>
);

export default App;
