import axios from "axios";

import { MappedParameters, Secrets } from "@atomist/automation-client";
import { MappedParameter, Secret } from "@atomist/automation-client/decorators";
import { HandlerContext } from "@atomist/automation-client/HandlerContext";
import { HandlerResult } from "@atomist/automation-client/HandlerResult";
import { logger } from "@atomist/automation-client/internal/util/logger";
import { GitHubRepoRef } from "@atomist/automation-client/operations/common/GitHubRepoRef";
import { generate } from "@atomist/automation-client/operations/generate/generatorUtils";
import { GitHubProjectPersister } from "@atomist/automation-client/operations/generate/gitHubProjectPersister";
import { ObjectStore } from "../../../web/ObjectStore";
import { SeedDrivenGenerator } from "@atomist/automation-client/operations/generate/SeedDrivenGenerator";
import { RepoId } from "@atomist/automation-client/operations/common/RepoId";

/**
 * Creates a GitHub Repo and installs Atomist collaborator if necessary
 */
export abstract class AbstractRepoCreator extends SeedDrivenGenerator implements RepoId {

    @Secret(Secrets.userToken(["repo", "user"]))
    protected githubToken;

    @MappedParameter(MappedParameters.GitHubOwner)
    public targetOwner: string;

    constructor(private store: ObjectStore,
                private collaborator?: string,
                private collaboratorToken?: string) {
        super();
    }

    get owner() {
        return this.targetOwner;
    }

    get repo() {
        return this.targetRepo;
    }

    public handle(ctx: HandlerContext, params: this): Promise<HandlerResult> {
        return generate(this.startingPoint(ctx, this),
            ctx,
            {token: params.githubToken},
            params.projectEditor(ctx, params),
            GitHubProjectPersister,
            params)
            .then(r => {
                // Store the repo we created
                const ref = new GitHubRepoRef(params.owner, params.repo);
                params.store.put(ref);
                logger.info("Remembering we created repo %j", ref);
                return ref;
            })
            .then(ref => this.addAtomistCollaborator(params, ref))
            .then(r => ({
                code: 0,
                // Redirect to our local project page
                redirect: `/projects/github/${params.targetOwner}/${params.targetRepo}`,
            }));
    }

    private addAtomistCollaborator(params: AbstractRepoCreator, ref: GitHubRepoRef): Promise<any> {
        if (!!params.collaborator) {
            const url = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/collaborators/${params.collaborator}`;
            logger.info("Attempting to install %s as a collaborator on %s:%s calling URL [%s]",
                params.collaborator, ref.owner, ref.repo, url);
            return axios.put(
                url,
                {permission: "push"},
                {headers: {Authorization: `token ${params.githubToken}`}})
                .catch(err => {
                    logger.warn("Unable to install %s as a collaborator on %s:%s - Failed with %s",
                        params.collaborator, ref.owner, ref.repo, err);
                })
                .then(res => this.acceptInvitation(params.collaboratorToken, ref, res));
        } else {
            logger.warn("No collaborator configured on %s:%s - Not installing", ref.owner, ref.repo);
            return Promise.resolve(true);
        }
    }

    private acceptInvitation(collaboratorToken: string, ref: GitHubRepoRef,
                             response: boolean | any /* AxiosResponse from add collaborator */): Promise<any> {
        if (response) {
            const invitationId = response.data.id;
            logger.debug("Accepting invitation %s", invitationId);
            return axios.patch(`${ref.apiBase}/user/repository_invitations/${invitationId}`, "",
                {headers: {Authorization: `token ${collaboratorToken}`}}).then(yay => {
                logger.debug(`invitation accepted!`);
                return yay;
            }).catch(err => {
                logger.warn("Failure accepting invitation to %s/%s: %s", ref.owner, ref.repo, err);
            });
        } else {
            return Promise.resolve(false);
        }
    }

}