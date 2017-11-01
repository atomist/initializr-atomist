import axios from "axios";

import { CommandHandler, MappedParameter, Secret } from "@atomist/automation-client/decorators";
import { HandlerContext } from "@atomist/automation-client/HandlerContext";
import { HandlerResult } from "@atomist/automation-client/HandlerResult";
import { ProjectPersister } from "@atomist/automation-client/operations/generate/generatorUtils";
import { GitHubProjectPersister } from "@atomist/automation-client/operations/generate/gitHubProjectPersister";
import { RepoId } from "@atomist/automation-client/operations/common/RepoId";
import { AbstractSpringGenerator } from "./AbstractSpringGenerator";
import { MappedParameters, Secrets } from "@atomist/automation-client/Handlers";
import { DefaultDirectoryManager } from "@atomist/automation-client/project/git/GitCommandGitProject";
import { Project } from "@atomist/automation-client/project/Project";
import { ActionResult } from "@atomist/automation-client/action/ActionResult";
import { AnyProjectEditor, toEditor } from "@atomist/automation-client/operations/edit/projectEditor";
import { ProjectOperationCredentials } from "@atomist/automation-client/operations/common/ProjectOperationCredentials";
import { NodeFsLocalProject } from "@atomist/automation-client/project/local/NodeFsLocalProject";
import { logger } from "@atomist/automation-client/internal/util/logger";
import { LocalProject } from "@atomist/automation-client/project/local/LocalProject";
import { ObjectStore } from "../../../web/ObjectStore";
import { GitHubRepoRef } from "@atomist/automation-client/operations/common/GitHubRepoRef";

@CommandHandler("generate spring boot seed")
export class RepoCreator extends AbstractSpringGenerator implements RepoId {

    @Secret(Secrets.userToken(["repo", "user"]))
    protected githubToken;

    @MappedParameter(MappedParameters.GitHubOwner)
    public targetOwner: string;

    get owner() {
        return this.targetOwner;
    }

    get repo() {
        return this.targetRepo;
    }

    constructor(private store: ObjectStore,
                private collaborator?: string,
                private collaboratorToken?: string) {
        super();
    }

    public handle(ctx: HandlerContext, params: this): Promise<HandlerResult> {
        return generate(this.startingPoint(ctx, this),
            ctx,
            {token: params.collaboratorToken},
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
            .then(this.addAtomistCollaborator)
            .then(r => ({
                code: 0,
                redirect: `https://github.com/${params.targetOwner}/${params.targetRepo}`,
            }));
    }

    private addAtomistCollaborator(ref: GitHubRepoRef): Promise<any> {
        return !!this.collaborator ?
            axios.post(
                `${ref.apiBase}repos/${ref.owner}/${ref.repo}/collaborators/${this.collaborator}`,
                {permission: "push"},
                {headers: {Authorization: `token ${this.collaboratorToken}`}})
                .catch(err => {
                    logger.warn("Unable to install %s as a collaborator on %s:%s - Failed with %s", this.collaborator, ref.owner, ref.repo, err)
                }) :
            Promise.resolve(true);
    }

}

// TODO this can be replaced by client library version
export function generate<P extends RepoId>(startingPoint: Promise<Project>,
                                           ctx: HandlerContext,
                                           credentials: ProjectOperationCredentials,
                                           editor: AnyProjectEditor<P>,
                                           persist: ProjectPersister<P>,
                                           params: P): Promise<ActionResult<Project>> {
    const parentDir = DefaultDirectoryManager.opts.baseDir;
    return startingPoint
        .then(seed =>
            // Make a copy that we can work on
            NodeFsLocalProject.copy(seed, parentDir, params.repo))
        // Let's be sure we didn't inherit any old git stuff
        .then(proj => proj.deleteDirectory(".git"))
        .then(independentCopy => toEditor(editor)(independentCopy, ctx, params))
        .then(r => r.target)
        .then(populated => {
            logger.debug("Persisting repo at [%s] to GitHub: %s:%s",
                (populated as LocalProject).baseDir, params.owner, params.repo);
            return persist(populated, credentials, params)
        });

}
