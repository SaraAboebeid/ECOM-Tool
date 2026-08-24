import { useState, useEffect, useMemo, useRef, ReactNode } from 'react';
import { Graph } from './components/Graph/';
import { TimelineBar } from './components/TimelineBar';
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
import { dayOf, setAnalysisDay } from './utils/analysisWindow';
import {
  ApiError,
  CommunityDefinition,
  ScenarioSummary,
  dispatchCommunity,
  listScenarios,
  loadScenario,
} from './api/community';

/** A dispatch takes ~2 s, so wait for the slider to settle before asking. */
const DISPATCH_DEBOUNCE_MS = 400;

/* Console panel icons. Stroked at 1.7px on a 24 viewbox so they sit
   consistently in the tinted tile, matching the header stat cards. */
const PanelIcon = ({ d }: { d: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const MembersGlyph = () => <PanelIcon d="M4 21V7l6-3v17M14 21V10l6 3v8M7 10h.01M7 14h.01M17 15h.01" />;
const GridGlyph = () => <PanelIcon d="M13 2 L4 14h7l-1 8 9-12h-7z" />;
const OptimizeGlyph = () => <PanelIcon d="M4 19h16M6 15l4-5 3 3 5-7" />;
const ParamsGlyph = () => <PanelIcon d="M4 7h9M17 7h3M4 17h4M12 17h8M15 4v6M8 14v6" />;

/** A quiet heading that groups the console panels below it. */
const ConsoleGroup = ({ label, edge }: { label: string; edge: string }) => (
  <p className="console-group" style={{ ['--group-edge' as string]: edge }}>
    {label}
  </p>
);

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
  // Empty until a scenario loads from the backend; there is no built-in
  // fallback community any more.
  const [definition, setDefinition] = useState<CommunityDefinition | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ period: string; hours: number } | null>(null);
  // Owners are seeded from the first successful response only; re-seeding on
  // every dispatch would reset the user's filter selection mid-session.
  const ownersSeeded = useRef(false);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [activeScenario, setActiveScenario] = useState<string>('');
  // Buildings taken out of the community. Held separately so they can be
  // restored; dropping them from `definition` alone would lose their spec.
  const [excludedBuildings, setExcludedBuildings] = useState<Record<string, unknown>>({});
  // Only the parameters the user actually changed. Anything absent keeps
  // LEC-Opt's committed default, so an empty object reproduces the model as
  // the optimization team runs it.
  const [optimizerParams, setOptimizerParams] = useState<Record<string, number>>({});
  // Collapsing the console widens the map, so the layout has to know.
  const [isConsoleCollapsed, setIsConsoleCollapsed] = useState(false);

  // Only real communities are offered. The synthetic 3-building demo used to
  // head this list, but it invited comparisons against a made-up campus.
  useEffect(() => {
    listScenarios()
      .then((found) => {
        setScenarios(found);
        // Prefer the verified subset: every building in it has measured demand,
        // a real footprint and a sourced floor count.
        const preferred =
          found.find((s) => s.name === 'campus_verified') ??
          found.find((s) => s.name.startsWith('campus')) ??
          found[0];
        if (preferred) setActiveScenario(preferred.name);
      })
      .catch((err) =>
        setDispatchError(
          `Could not list scenarios: ${err?.message ?? err}\n` +
          'Start the backend with:\n' +
          'cd Dashboard/backend && python -m uvicorn app.main:app --port 8000',
        ),
      );
  }, []);

  useEffect(() => {
    if (!activeScenario) return;
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
    // Nothing to dispatch until a scenario has loaded from the backend.
    if (!definition) return;

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

  /** Move the dispatched window to another day, in either year. */
  const handleDayChange = (nextDay: string) => {
    if (!definition) return;
    setCurrentHour(0);
    setDefinition(setAnalysisDay(definition, nextDay));
  };

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
              <div className={`workspace-grid h-full ${isConsoleCollapsed ? 'workspace-grid--console-collapsed' : ''}`}>
                <div className={`workspace-console min-h-0 ${isConsoleCollapsed ? 'workspace-console--collapsed' : ''}`}>
                  <ConsoleRail
                    onCollapsedChange={setIsConsoleCollapsed}
                    footer={
                      <button
                        onClick={toggleDarkMode}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg
                                   border border-slate-200 dark:border-slate-700
                                   hover:bg-white/70 dark:hover:bg-slate-800 transition-colors"
                        aria-pressed={isDarkMode}
                        title={isDarkMode ? 'Switch to bright' : 'Switch to dark'}
                      >
                        {isDarkMode
                          ? <SunIcon className="w-4 h-4 text-amber-400" />
                          : <MoonIcon className="w-4 h-4 text-slate-600" />}
                        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]
                                         text-slate-500 dark:text-slate-400">Display</span>
                        <span className="ml-auto text-[10px] font-semibold
                                         text-slate-700 dark:text-slate-200">
                          {isDarkMode ? 'Dark' : 'Bright'}
                        </span>
                      </button>
                    }
                    footerCollapsed={
                      <button
                        onClick={toggleDarkMode}
                        className="w-9 h-9 flex items-center justify-center rounded-lg
                                   border border-slate-200 dark:border-slate-700
                                   hover:bg-white/70 dark:hover:bg-slate-800 transition-colors"
                        aria-pressed={isDarkMode}
                        title={isDarkMode ? 'Switch to bright' : 'Switch to dark'}
                      >
                        {isDarkMode
                          ? <SunIcon className="w-4 h-4 text-amber-400" />
                          : <MoonIcon className="w-4 h-4 text-slate-600" />}
                      </button>
                    }
                  >
                    {!definition && (
                      <p className="console-panel px-3 py-2 text-[11px] text-slate-500">
                        Loading community…
                      </p>
                    )}
                    {definition && (<>
                    <ConsoleGroup label="Community" edge="rgb(14 165 233)" />

                    <ConsolePanel
                      title="Members"
                      subtitle={`${definition.buildings.length} buildings`}
                      icon={<MembersGlyph />}
                      accent="sky"
                      status={dispatchError ? 'error' : isComputing ? 'busy' : 'ok'}
                      defaultOpen
                      maxBodyHeight={460}
                    >
                      <MembersPanel
                        definition={definition}
                        onChange={setDefinition}
                        excluded={excludedBuildings}
                        onExcludedChange={setExcludedBuildings}
                        selfSufficiency={data?.kpis?.self_sufficiency ?? null}
                        filters={
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
                        }
                      />
                    </ConsolePanel>

                    <ConsolePanel
                      title="Grid & storage"
                      subtitle={meta?.period ? `${meta.hours} h dispatched` : 'prices, battery'}
                      icon={<GridGlyph />}
                      accent="emerald"
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

                    <ConsoleGroup label="Analyse" edge="rgb(139 92 246)" />

                    <ConsolePanel
                      title="Optimization"
                      subtitle="run, sweep, cost curve"
                      icon={<OptimizeGlyph />}
                      accent="violet"
                      maxBodyHeight={520}
                    >
                      <OptimizationPanel
                        definition={definition}
                        parameters={optimizerParams}
                      />
                      <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                        <p className="text-[9px] font-bold uppercase tracking-[0.12em]
                                      text-slate-400 dark:text-slate-500 mb-1.5">
                          Find the cheapest size
                        </p>
                        <SizingPanel
                          definition={definition}
                          parameters={optimizerParams}
                        />
                      </div>
                    </ConsolePanel>

                    <ConsoleGroup label="Model" edge="rgb(100 116 139)" />

                    <ConsolePanel
                      title="Parameters"
                      icon={<ParamsGlyph />}
                      accent="slate"
                      subtitle={
                        Object.keys(optimizerParams).length
                          ? `${Object.keys(optimizerParams).length} changed`
                          : '13 model constants'
                      }
                      maxBodyHeight={440}
                    >
                      <ParametersPanel
                        value={optimizerParams}
                        onChange={setOptimizerParams}
                      />
                    </ConsolePanel>
                    </>)}

                  </ConsoleRail>
                </div>

                <div className="workspace-main min-h-0">
                  <div className="relative viewer-shell flex-1 min-h-[420px] rounded-2xl overflow-hidden border border-slate-200/70 dark:border-slate-700/70">
                    {/* Only fit-to-view stays on the map, tucked under the
                        north arrow in the same corner. The compass and theme
                        toggle moved into the console so nothing crowds the
                        arrow. */}
                    <div className="absolute top-[92px] right-4 z-50">
                      <button
                        onClick={onFitToViewClick}
                        disabled={!fitToViewFn}
                        className="viewer-fab disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Fit graph to view"
                        title="Fit graph to view"
                      >
                        <FitToViewIcon className="w-5 h-5 text-slate-700 dark:text-slate-200" />
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
                    <TimelineBar
                      day={definition ? dayOf(definition) : '2022-06-01'}
                      onDayChange={handleDayChange}
                      currentHour={currentHour}
                      onHourChange={setCurrentHour}
                      totalHours={meta?.hours ?? 24}
                      isPlaying={isPlaying}
                      onPlayPause={togglePlayPause}
                      isComputing={isComputing}
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


export default App;
