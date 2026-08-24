import { Redacted } from "effect";

import { applicationConfigurationLimits } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import {
    configurationError,
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

/** One worker-only GitHub identity retained exclusively as redacted values. */
export interface GitHubOrdinaryCredentialsConfiguration {
    readonly token: Redacted.Redacted<string>;
    readonly username: Redacted.Redacted<string>;
}

/** Separated worker-only GitHub authorities for ordinary and review operations. */
export interface GitHubCredentialsConfiguration {
    readonly ordinary?: GitHubOrdinaryCredentialsConfiguration;
    readonly reviewerToken?: Redacted.Redacted<string>;
}

function isAbsent(value: unknown): boolean {
    return value === null || value === undefined || value === "";
}

/**
 * Parses the fixed Mira and Raymond GitHub authority boundary.
 * @param input Worker-owned environment values.
 * @returns Separated credentials, or undefined when both authorities are absent.
 */
export function configurationGitHubCredentials(
    input: PickedApplicationEnvironment
): GitHubCredentialsConfiguration | undefined {
    const usernameAbsent = isAbsent(input.MIRA_GITHUB_USERNAME);
    const tokenAbsent = isAbsent(input.MIRA_GITHUB_TOKEN);
    if (usernameAbsent !== tokenAbsent) {
        configurationError(
            usernameAbsent ? "MIRA_GITHUB_USERNAME" : "MIRA_GITHUB_TOKEN",
            "missing"
        );
    }
    const ordinary = usernameAbsent
        ? undefined
        : Object.freeze({
              token: Object.freeze(
                  Redacted.make(
                      requiredConfigurationString(
                          input,
                          "MIRA_GITHUB_TOKEN",
                          applicationConfigurationLimits.githubTokenMaximumLength
                      ),
                      { label: "mira-github-token" }
                  )
              ),
              username: Object.freeze(
                  Redacted.make(
                      requiredConfigurationString(
                          input,
                          "MIRA_GITHUB_USERNAME",
                          applicationConfigurationLimits.githubUsernameMaximumLength
                      ),
                      { label: "mira-github-username" }
                  )
              ),
          });
    const reviewerToken = isAbsent(input.RAJOHAN_GITHUB_TOKEN)
        ? undefined
        : Object.freeze(
              Redacted.make(
                  requiredConfigurationString(
                      input,
                      "RAJOHAN_GITHUB_TOKEN",
                      applicationConfigurationLimits.githubTokenMaximumLength
                  ),
                  { label: "rajohan-github-review-token" }
              )
          );
    if (ordinary === undefined && reviewerToken === undefined) return undefined;
    return Object.freeze({
        ...(ordinary === undefined ? {} : { ordinary }),
        ...(reviewerToken === undefined ? {} : { reviewerToken }),
    });
}
