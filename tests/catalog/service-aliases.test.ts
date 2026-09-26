import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function uniqueFixtureServiceNames(): string[] {
  const names = new Set<string>();
  for (const session of fixture) {
    for (const service of session.services ?? []) {
      names.add(service);
    }
  }
  return [...names];
}

describe("buildServiceAliasIndex", () => {
  it("resolves lambda to AWS Lambda", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("lambda")).toBe("AWS Lambda");
  });

  it("resolves s3 to the full Amazon Simple Storage Service name via the parenthetical abbreviation", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("s3")).toBe("Amazon Simple Storage Service (Amazon S3)");
  });

  it("resolves ecs, eks and ec2 from their parentheticals", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("ecs")).toBe("Amazon Elastic Container Service (Amazon ECS)");
    expect(index.resolve("eks")).toBe("Amazon Elastic Kubernetes Service (Amazon EKS)");
    expect(index.resolve("ec2")).toBe("Amazon Elastic Compute Cloud (Amazon EC2)");
  });

  it("resolves dynamodb from a name with no parenthetical", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("dynamodb")).toBe("Amazon DynamoDB");
  });

  it("resolves elb from a bare parenthetical with no Amazon or AWS prefix", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("elb")).toBe("Elastic Load Balancing (ELB)");
  });

  it("resolves apigateway from a multi-word name with the spaces removed", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("apigateway")).toBe("Amazon API Gateway");
  });

  it("resolves sfn to AWS Step Functions through the override table", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("sfn")).toBe("AWS Step Functions");
  });

  it("resolves bedrock-runtime to Amazon Bedrock through the override table", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("bedrock-runtime")).toBe("Amazon Bedrock");
  });

  it("resolves sagemaker-runtime to Amazon SageMaker through the override table", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("sagemaker-runtime")).toBe("Amazon SageMaker");
  });

  it("returns null for sns, which has no counterpart in the catalog", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("sns")).toBeNull();
  });

  it("does not resolve an override whose canonical name is absent from this catalog", () => {
    // "AWS Step Functions" is dropped here -- even though "sfn" is in the override table,
    // resolving it anyway would falsely claim this catalog has a service it does not.
    const namesWithoutStepFunctions = uniqueFixtureServiceNames().filter(
      (name) => name !== "AWS Step Functions",
    );
    const index = buildServiceAliasIndex(namesWithoutStepFunctions);

    expect(index.resolve("sfn")).toBeNull();
  });

  it("builds the index from the fixture with no collisions", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.collisions).toEqual([]);
  });

  it("drops a colliding alias to null rather than making the index unusable", () => {
    // A synthetic pair, not drawn from the real catalog (which has no such collision): both
    // strip to the same base name once their vendor prefix is removed, so they must collide on
    // the alias "widget" under the actual derivation rules, not a contrived shortcut. A rename on
    // AWS's side must degrade one alias, not break every user's `match` command.
    const index = buildServiceAliasIndex(["AWS Widget", "Amazon Widget"]);

    expect(index.resolve("widget")).toBeNull();
  });

  it("still resolves each colliding service's own full display name", () => {
    const index = buildServiceAliasIndex(["AWS Widget", "Amazon Widget"]);

    expect(index.resolve("AWS Widget")).toBe("AWS Widget");
    expect(index.resolve("Amazon Widget")).toBe("Amazon Widget");
    expect(index.resolve("aws widget")).toBe("AWS Widget");
    expect(index.resolve("amazon widget")).toBe("Amazon Widget");
  });

  it("lists a dropped alias in collisions with every canonical name that produced it", () => {
    const index = buildServiceAliasIndex(["AWS Widget", "Amazon Widget"]);

    expect(index.collisions).toEqual([
      { alias: "widget", canonicalNames: ["AWS Widget", "Amazon Widget"] },
    ]);
  });

  it("does not drop a name's own unique alias just because one of its other aliases collided", () => {
    // "AWS Widget" derives two aliases: "widget" (which collides with "Amazon Widget") and
    // "awswidget" (unique to it, from the full name). Dropping the colliding alias must not also
    // drop the unique one -- collisions are tracked per alias, not per canonical name.
    const index = buildServiceAliasIndex(["AWS Widget", "Amazon Widget"]);

    expect(index.resolve("awswidget")).toBe("AWS Widget");
    expect(index.resolve("amazonwidget")).toBe("Amazon Widget");
    expect(index.resolve("widget")).toBeNull();
  });

  it("is not corrupted by an alias that collides with an Object.prototype member", () => {
    // "AWS Constructor" strips to "constructor" -- the name of a plain object's inherited
    // constructor property. A lookup backed by a Map (rather than a plain object used as a map)
    // cannot confuse this with an inherited member either way.
    const index = buildServiceAliasIndex(["AWS Constructor", "AWS Lambda"]);

    expect(index.resolve("constructor")).toBe("AWS Constructor");
    expect(index.resolve("toString")).toBeNull();
    expect(index.resolve("hasOwnProperty")).toBeNull();
    expect(index.resolve("lambda")).toBe("AWS Lambda");
  });

  it("resolves case-insensitively and ignoring punctuation", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("LAMBDA")).toBe("AWS Lambda");
    expect(index.resolve("aws-lambda")).toBe("AWS Lambda");
  });

  it("returns null for an alias with no relationship to any catalog service name", () => {
    const index = buildServiceAliasIndex(uniqueFixtureServiceNames());

    expect(index.resolve("not-a-real-service")).toBeNull();
  });
});
