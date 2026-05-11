import { LinearClient } from "@linear/sdk";
import type { Config } from "./config.js";

/**
 * Trimmed-down view of a Linear issue — just what runway's loop needs.
 * Resolved up-front so the orchestrator doesn't have to round-trip the
 * SDK for every field.
 */
export interface RunwayIssue {
  readonly id: string;
  readonly identifier: string; // "VA-123"
  readonly title: string;
  readonly description: string;
}

export interface LinearGateway {
  fetchReady(): Promise<RunwayIssue[]>;
  transition(issueId: string, statusName: string): Promise<void>;
  applyLabel(issueId: string, labelName: string): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;
}

/**
 * Concrete @linear/sdk-backed implementation. Tests inject their own
 * gateway; never reach for the SDK directly outside this file.
 */
export function createLinearGateway(config: Config): LinearGateway {
  const client = new LinearClient({ apiKey: config.linearApiKey });

  async function findStateId(teamId: string, name: string): Promise<string> {
    const states = await client.workflowStates({
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    const state = states.nodes[0];
    if (!state) {
      throw new Error(
        `Linear workflow state "${name}" not found on team ${teamId}`,
      );
    }
    return state.id;
  }

  async function findTeamId(): Promise<string> {
    const teams = await client.teams({
      filter: { key: { eq: config.linearTeam } },
    });
    const team = teams.nodes[0];
    if (!team) {
      throw new Error(`Linear team "${config.linearTeam}" not found`);
    }
    return team.id;
  }

  /**
   * Resolve a project identifier (UUID, slug, or name) to its Linear
   * project ID. Tries each shape in order so user-facing flags like
   * `--project=bedrock` work without forcing users to copy the UUID.
   */
  async function findProjectId(identifier: string): Promise<string> {
    const projects = await client.projects({
      filter: {
        or: [
          { id: { eq: identifier } },
          { slugId: { eq: identifier } },
          { name: { eq: identifier } },
        ],
      },
    });
    const project = projects.nodes[0];
    if (!project) {
      throw new Error(`Linear project "${identifier}" not found`);
    }
    return project.id;
  }

  return {
    async fetchReady() {
      const teamId = await findTeamId();
      const readyStateId = await findStateId(teamId, config.readyStatus);
      const projectId = config.linearProject
        ? await findProjectId(config.linearProject)
        : null;
      const issues = await client.issues({
        filter: {
          team: { id: { eq: teamId } },
          state: { id: { eq: readyStateId } },
          ...(projectId ? { project: { id: { eq: projectId } } } : {}),
        },
        // Stable order: oldest first so the queue drains FIFO.
        orderBy: "createdAt" as never,
      });
      return issues.nodes.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        description: i.description ?? "",
      }));
    },

    async transition(issueId, statusName) {
      const issue = await client.issue(issueId);
      const team = await issue.team;
      if (!team) throw new Error(`Issue ${issueId} has no team`);
      const stateId = await findStateId(team.id, statusName);
      await client.updateIssue(issueId, { stateId });
    },

    async applyLabel(issueId, labelName) {
      const issue = await client.issue(issueId);
      const team = await issue.team;
      if (!team) throw new Error(`Issue ${issueId} has no team`);
      const labels = await client.issueLabels({
        filter: {
          team: { id: { eq: team.id } },
          name: { eq: labelName },
        },
      });
      const label = labels.nodes[0];
      if (!label) {
        throw new Error(
          `Linear label "${labelName}" not found on team ${team.id}`,
        );
      }
      const existing = await issue.labels();
      const labelIds = [
        ...existing.nodes.map((l) => l.id),
        label.id,
      ];
      await client.updateIssue(issueId, { labelIds });
    },

    async comment(issueId, body) {
      await client.createComment({ issueId, body });
    },
  };
}

/**
 * VA-354: read-only preflight that surfaces every Linear-side
 * misconfiguration `runway run` would hit. Returns a structured
 * result; the caller (currently `runway doctor`) decides how to
 * render. The returned `availableLabels` are sampled (max 50) so a
 * red ✗ on a missing label can show the operator what IS there.
 */
export interface LinearValidationResult {
  readonly team:
    | { kind: "ok"; id: string }
    | { kind: "missing"; key: string };
  readonly readyStatus: StateValidation;
  readonly inProgressStatus: StateValidation;
  readonly inReviewStatus: StateValidation;
  readonly hitlLabel:
    | { kind: "ok"; name: string }
    | { kind: "missing"; name: string; available: readonly string[] }
    | { kind: "skipped"; reason: string };
}

type StateValidation =
  | { kind: "ok"; name: string }
  | { kind: "missing"; name: string; available: readonly string[] }
  | { kind: "skipped"; reason: string };

export async function validateLinearConfig(
  config: Config,
): Promise<LinearValidationResult> {
  const client = new LinearClient({ apiKey: config.linearApiKey });

  const teams = await client.teams({
    filter: { key: { eq: config.linearTeam } },
  });
  const team = teams.nodes[0];
  if (!team) {
    return {
      team: { kind: "missing", key: config.linearTeam },
      readyStatus: { kind: "skipped", reason: "team missing" },
      inProgressStatus: { kind: "skipped", reason: "team missing" },
      inReviewStatus: { kind: "skipped", reason: "team missing" },
      hitlLabel: { kind: "skipped", reason: "team missing" },
    };
  }

  const states = await client.workflowStates({
    filter: { team: { id: { eq: team.id } } },
  });
  const stateNames = states.nodes.map((s) => s.name);
  const checkState = (want: string): StateValidation =>
    stateNames.includes(want)
      ? { kind: "ok", name: want }
      : { kind: "missing", name: want, available: stateNames };

  const labels = await client.issueLabels({
    filter: { team: { id: { eq: team.id } } },
  });
  const labelNames = labels.nodes.map((l) => l.name);
  const hitlLabel = labelNames.includes(config.hitlLabel)
    ? { kind: "ok" as const, name: config.hitlLabel }
    : {
        kind: "missing" as const,
        name: config.hitlLabel,
        available: labelNames.slice(0, 50),
      };

  return {
    team: { kind: "ok", id: team.id },
    readyStatus: checkState(config.readyStatus),
    inProgressStatus: checkState(config.inProgressStatus),
    inReviewStatus: checkState(config.inReviewStatus),
    hitlLabel,
  };
}
