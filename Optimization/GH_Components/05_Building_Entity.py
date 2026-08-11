#! python3
# r: pandas

# Building: Honeybee-Compatible Building Entity (MIT)
# Designed for use inside Grasshopper (GH) for Rhino by ECOM4Future

"""
Create a Honeybee-compatible Building object for energy community simulations.

    Args:
        name: Building name or ID (string). Must be unique within the community.
        footprints: Rhino Brep, Surface or Curve (or a list of them) representing the
            building footprint. A plain number is also accepted and is treated as a
            footprint area in m2, for use outside Rhino.
        building_type: Honeybee program type (e.g. "MidriseApartment", "SmallOffice",
            "College"). Validated against the Honeybee library when honeybee_energy
            is installed; passed through unchecked when it is not.
        occupancy_schedule: Honeybee ScheduleRuleset or ScheduleFixedInterval.
            Optional. Convert to a DataFrame with convert_schedule_to_df=True.
        electric_demand: One of
            - a list of exactly 8760 hourly values in kWh
            - a path to a CSV containing 8760 values
            - an HourlyData object
            A single annual total is NOT accepted - see the note below.
        PV_plant: One or more PV Plant objects. Optional.
        owner: Must be one of "Akademiska Hus", "Studentbostäder", "Chalmersfastigheter".
        breps: Optional Rhino Breps for the 3D volume. Falls back to any Breps
            found in footprints.
        number_of_floors: Multiplier applied to the footprint area. Optional.
        point: Optional Rhino Point3d used as the building's map location. Supply
            this if the results feed the dashboard, which positions nodes by x/y.
        convert_schedule_to_df: Optional boolean.

    Returns:
        report: Validation message, or the error if construction failed.
        building: Building object, to pass into the merge component.
        electric_demand: Parsed HourlyData demand profile.
        total_energy_demand: Total electric demand (kWh/year).
        total_pv_capacity: Total installed PV capacity (kW).
        total_installed_capacity: Same as total_pv_capacity in the current toolkit.
        area: Footprint area x number_of_floors (m2).
        fractional_hourly_electric_demand: Normalised program-based profile.
        electric_demand_from_program: Demand derived from the Honeybee program and
            area, rather than from the electric_demand input.

NOTE on annual demand:
    Earlier documentation claimed a single annual total was accepted. It is not -
    Building._parse_electric_demand raises ValueError. Expanding an annual figure
    to 8760 values requires choosing a load shape, and a flat profile would quietly
    produce misleading dispatch and peak results. Shape it explicitly upstream and
    pass the 8760 values.

NOTE on embodied CO2:
    Earlier documentation listed construction_embodied_co2 as an input and
    total_embodied_co2 as an output. Neither exists in the Building class. They are
    not exposed here rather than being faked with zeros.

NOTE on batteries:
    Batteries are not a Building input. Attach them at the EnergyCommunity level.

The last two properties require honeybee_energy. Without it they are returned as
None and a note is added to the report, instead of raising.
"""

ghenv.Component.Name = 'Building'
ghenv.Component.NickName = 'Building'
ghenv.Component.Message = '0.0.2'
ghenv.Component.Category = 'ECOM4Future'
ghenv.Component.SubCategory = 'Entities'
ghenv.Component.AdditionalHelpFromDocStrings = '2'

import traceback

from ECOMToolkit.entities import Building

VALID_OWNERS = ["Akademiska Hus", "Studentbostäder", "Chalmersfastigheter"]

building = None
electric_demand = None
total_energy_demand = 0.0
total_pv_capacity = 0.0
total_installed_capacity = 0.0
area = 0.0
fractional_hourly_electric_demand = None
electric_demand_from_program = None
notes = []

# --- Pre-flight checks, so the failure names the input rather than surfacing
# --- as a ValueError from somewhere inside the class.
problems = []
if not name:
    problems.append("name is required and must be unique within the community.")
if footprints is None:
    problems.append("footprints is required (Rhino geometry, or a number as area in m2).")
if not building_type:
    problems.append("building_type is required, e.g. 'College' or 'MidriseApartment'.")
if owner not in VALID_OWNERS:
    problems.append("owner must be one of {}, got {!r}.".format(VALID_OWNERS, owner))

if electric_demand_input is None:
    problems.append("electric_demand is required.")
elif isinstance(electric_demand_input, (int, float)) and not isinstance(electric_demand_input, bool):
    problems.append(
        "electric_demand got a single number ({}). An annual total is not accepted - "
        "supply 8760 hourly values or a CSV path. See the NOTE in this component's "
        "description.".format(electric_demand_input))
elif isinstance(electric_demand_input, list) and len(electric_demand_input) != 8760:
    problems.append("electric_demand has {} values, exactly 8760 are required."
                    .format(len(electric_demand_input)))

if problems:
    report = "Building not created:\n- " + "\n- ".join(problems)
else:
    try:
        building = Building(
            name=name,
            footprints=footprints,
            building_type=building_type,
            occupancy_schedule=occupancy_schedule,
            electric_demand=electric_demand_input,
            PV_plant=PV_plant,
            owner=owner,
            convert_schedule_to_df=bool(convert_schedule_to_df),
            breps=breps,
            number_of_floors=number_of_floors,
            point=point,
        )

        report = building.validate()
        electric_demand = building.electric_demand
        total_energy_demand = building.total_energy_demand
        total_pv_capacity = building.total_pv_capacity
        total_installed_capacity = building.total_installed_capacity
        area = building.area

        # These need honeybee_energy. Degrade to None with a note rather than
        # letting the component go red for an optional feature.
        try:
            fractional_hourly_electric_demand = building.fractional_hourly_electric_demand
        except Exception as prog_err:
            notes.append("fractional_hourly_electric_demand unavailable: {}".format(prog_err))
        try:
            electric_demand_from_program = building.electric_demand_from_program
        except Exception as prog_err:
            notes.append("electric_demand_from_program unavailable: {}".format(prog_err))

        if area == 0.0:
            notes.append("area is 0 - footprints produced no measurable geometry. "
                         "Program-based demand scales with area and will also be 0.")
        if point is None:
            notes.append("No point supplied, so x/y are None. The dashboard positions "
                         "nodes by x/y and will fall back to a computed layout.")

        if notes:
            report = report + "\n\nNOTES:\n- " + "\n- ".join(notes)

    except Exception as err:
        building = None
        report = "Building not created: {}\n\n{}".format(err, traceback.format_exc())
