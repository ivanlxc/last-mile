import type { SceneId } from "../../../docs/engineering_v0.5/contracts/public.types";

export const campaign = {
  title: "LAST MILE",
  subtitle: "The final stretch",
  callSign: "Daybreak 07",
  region: "Sahel Valley",
  premise: "Twenty people. One road home. No complete answers.",
  briefing: [
    "Dusk falls over Sahel Valley after a temporary ceasefire. Communications remain patchy. Daybreak Reception Point awaits on the far bank. Guide the convoy through three decision scenes and bring everyone there.",
    "Twenty civilians are on board. Some carry their house keys; others have only their papers. Explore the map, read intelligence and discuss your choices without an overall time limit. Elapsed mission time is recorded; investigations and travel still take their stated time.",
    "You command the convoy. Noah, your intelligence officer, handles imagery and road conditions. Samira, your liaison, contacts local agencies and witnesses. Your AI advisor can analyze the material you share. The final decision is yours.",
  ],
  closing: "The last stretch on the map is the start of twenty new chapters.",
  tutorial: [
    {
      number: "01",
      title: "Establish what you know",
      text: "Ask Noah or Samira for an existing briefing, or assign a new investigation. Each officer can submit up to 3 reports per scene. Completed investigations submit a report automatically.",
    },
    {
      number: "02",
      title: "Choose what the AI sees",
      text: "Upload up to 5 intelligence cards per scene. The AI cannot automatically see other cards, elapsed mission time, or your remaining resources. Anything you type is marked as your unverified statement.",
    },
    {
      number: "03",
      title: "Acting leaves questions open",
      text: "Investigations take time and use resources shared across the mission. Choosing a route sends the convoy on its way and cancels unfinished investigations. Spent channel uses are not refunded.",
    },
    {
      number: "04",
      title: "Look back at your decisions",
      text: "The debrief separates the mission outcome from how you used information. Reaching safety does not make every judgment sound. Where evidence is insufficient, the review will say so.",
    },
  ],
};

export const characters = {
  analyst: {
    name: "Noah",
    nameEn: "NOAH",
    role: "Intelligence officer",
    initials: "N",
    channel: "Imagery / Roads",
    line: "I can tell you what is in the image—and what it cannot show us.",
  },
  liaison: {
    name: "Samira",
    nameEn: "SAMIRA",
    role: "Liaison officer",
    initials: "S",
    channel: "Agencies / Witnesses",
    line: "I will establish who saw it firsthand, and who heard it from someone else.",
  },
};

export const scenes: Record<
  SceneId,
  {
    number: string;
    title: string;
    english: string;
    location: string;
    image: string;
    intro: string;
    radio: string;
    speaker: string;
    atmosphere: string;
    topics: { id: string; label: string }[];
  }
> = {
  E1: {
    number: "01",
    title: "Beyond the gate",
    english: "THE WEST GATE",
    location: "West Gate Checkpoint · N01",
    image: "/assets/gate.png",
    intro:
      "Fragments of registration instructions crackle over the checkpoint radio. The main road runs through the west gate; a southern service road loops toward the market. The map shows both routes. It cannot tell you which to take now.",
    radio:
      "I have the passenger list. We can register at the main gate. If we go around, we will still need to handle that later.",
    speaker: "Samira",
    atmosphere:
      "Engines idle softly. A passenger folds their papers around a house key, then slips both into a coat pocket.",
    topics: [
      { id: "gate_status", label: "Current registration status" },
      { id: "manifest", label: "Passenger list and handover" },
      { id: "roads", label: "Route conditions" },
    ],
  },
  E2: {
    number: "02",
    title: "The weight of an echo",
    english: "ECHOES IN THE MARKET",
    location: "Old Market · N02",
    image: "/assets/market.png",
    intro:
      "A loud report carries out of the narrow streets. A white pickup, a roadblock, different storytellers—news travels faster than the convoy. What you need to establish is whether the main road is passable now.",
    radio:
      "Several accounts sound very similar. The number of people repeating a story is not the number who witnessed it.",
    speaker: "Samira",
    atmosphere:
      "Wind lifts the shop awnings. The lead vehicle's brake lights reflect in the windows.",
    topics: [
      { id: "roads", label: "Current road access" },
      { id: "cause", label: "Reports and their sources" },
    ],
  },
  E3: {
    number: "03",
    title: "Across the river",
    english: "THE OTHER SIDE",
    location: "Main Bridge, West End · N05",
    image: "/assets/bridge.png",
    intro:
      "The reception point is just across the river. The main bridge is more direct; the old riverbed track takes longer. The bridge looks intact in the fading light, but visible structure and permission for your vehicles to cross are separate questions.",
    radio:
      "Almost there. Please check both: is the bridge still standing, and can our vehicles cross it now?",
    speaker: "Noah",
    atmosphere:
      "The river catches the last light. Passengers gather their belongings. The passenger with the house key holds it quietly in one hand.",
    topics: [
      { id: "bridge_status", label: "Bridge and vehicle clearance" },
      { id: "ford_status", label: "Old riverbed track" },
      { id: "manifest", label: "Outstanding handover tasks" },
      { id: "roads", label: "Route conditions" },
    ],
  },
};

export const channelLabels = {
  satellite: "Satellite",
  drone: "Drone",
  localAgency: "Local agency",
  witness: "Witness",
};

export const dimensionLabels = {
  complacency: "Overreliance",
  distrust: "Excessive distrust",
  overCaution: "Excessive caution",
  calibratedTrust: "Calibrated trust",
};

export const supportLabels = {
  not_assessable: "Insufficient evidence",
  not_observed: "Not observed",
  observed_once: "One observation",
  repeated_observation: "Repeated observations",
};

export const reasonLabels = {
  evidence_supported: "Supported by known evidence",
  current_conflict: "A current contradiction",
  accepted_uncertainty_for_time: "Accepting uncertainty to save time",
  ai_said_so: "Mainly because the AI advised it",
  prior_ai_error_only: "Mainly because the AI was wrong before",
  new_question: "A new question needs answering",
  no_new_question: "No new question at present",
};
