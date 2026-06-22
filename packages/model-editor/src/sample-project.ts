// The canonical "Pet Store" sample project — one coherent contract projected across
// every layer the editor understands, so opening `main.tsp` populates all of the
// Entities · Endpoints · Channels · Flows · Source tabs and each item cross-links to
// what references it elsewhere. Shared by the VS Code extension's "Create Sample
// Project" command and the standalone demo's "Try a sample", so the two never drift.
//
// The `openapi.yaml` is what the contract would emit; the Arazzo workflow resolves
// its `sourceDescriptions` to it. Message payloads in the AsyncAPI doc `$ref` schemas
// named like the TypeSpec models, and channels carry an `x-operationId` that binds
// them to an HTTP endpoint — so the whole thing parses with zero diagnostics.

export interface SampleFile {
  name: string;
  content: string;
}

const PRISMA: SampleFile = {
  name: "schema.prisma",
  content: `// Sample Prisma schema — open in the Canopy Model Editor to edit it visually.
// Drag entities, draw relations, then export to SQL / JSON Schema / Mermaid.

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Owner {
  id        String   @id @default(cuid())
  name      String
  email     String   @unique
  pets      Pet[]
  createdAt DateTime @default(now())
}

model Pet {
  id        String   @id @default(cuid())
  name      String
  status    String   @default("available")
  owner     Owner?   @relation(fields: [ownerId], references: [id])
  ownerId   String?
  visits    Visit[]
  createdAt DateTime @default(now())
}

model Visit {
  id     String   @id @default(cuid())
  pet    Pet      @relation(fields: [petId], references: [id])
  petId  String
  date   DateTime
  notes  String?
}
`,
};

const TSP: SampleFile = {
  name: "main.tsp",
  content: `import "@typespec/http";

using TypeSpec.Http;

// The contract behind every other tab: models become Entities, operations become
// Endpoints, and the Arazzo + AsyncAPI files cross-link back to the ids declared here.
@service(#{ title: "Pet Store" })
namespace PetStore;

/** A pet's availability. */
enum PetStatus {
  available,
  pending,
  sold,
}

/** Returned when a request fails. */
@error
model Error {
  code: int32;
  message: string;
}

/** A person who owns pets. */
model Owner {
  @key id: string;
  name: string;
  email: string;
}

/** A pet in the store. */
model Pet {
  @key id: string;
  name: string;
  status: PetStatus;
  /** The owner this pet belongs to. */
  owner: Owner;
}

/** A vet visit booked for a pet. */
model Visit {
  @key id: string;
  pet: Pet;
  date: utcDateTime;
  notes?: string;
}

/** Request body to register an owner. */
model CreateOwner {
  name: string;
  email: string;
}

/** Request body to add a pet. */
model CreatePet {
  name: string;
  status: PetStatus;
  ownerId: string;
}

/** Request body to book a visit. */
model BookVisit {
  petId: string;
  date: utcDateTime;
  notes?: string;
}

@route("/owners")
@tag("owners")
interface Owners {
  @get @operationId("listOwners") list(): Owner[] | Error;
  @get @operationId("getOwner") read(@path id: string): Owner | Error;
  @post @operationId("createOwner") create(@body owner: CreateOwner): {
    @statusCode statusCode: 201;
    @body created: Owner;
  } | Error;
}

@route("/pets")
@tag("pets")
interface Pets {
  @get @operationId("listPets") list(@query status?: PetStatus): Pet[] | Error;
  @get @operationId("getPet") read(@path id: string): Pet | Error;
  @post @operationId("createPet") create(@body pet: CreatePet): {
    @statusCode statusCode: 201;
    @body created: Pet;
  } | Error;
  @patch @operationId("updatePetStatus") updateStatus(@path id: string, @body status: PetStatus): Pet | Error;
}

@route("/visits")
@tag("visits")
interface Visits {
  @post @operationId("bookVisit") book(@body visit: BookVisit): {
    @statusCode statusCode: 201;
    @body created: Visit;
  } | Error;
  @get @operationId("listVisits") list(@query petId: string): Visit[] | Error;
}
`,
};

const OPENAPI: SampleFile = {
  name: "openapi.yaml",
  content: `# The OpenAPI your .tsp would emit. The Arazzo workflow points its
# sourceDescriptions here, and the editor resolves that link by file name.
openapi: 3.0.0
info:
  title: Pet Store
  version: 1.0.0
paths:
  /owners:
    get: { operationId: listOwners, responses: { '200': { description: ok } } }
    post: { operationId: createOwner, responses: { '201': { description: created } } }
  /owners/{id}:
    get: { operationId: getOwner, responses: { '200': { description: ok } } }
  /pets:
    get: { operationId: listPets, responses: { '200': { description: ok } } }
    post: { operationId: createPet, responses: { '201': { description: created } } }
  /pets/{id}:
    get: { operationId: getPet, responses: { '200': { description: ok } } }
    patch: { operationId: updatePetStatus, responses: { '200': { description: ok } } }
  /visits:
    get: { operationId: listVisits, responses: { '200': { description: ok } } }
    post: { operationId: bookVisit, responses: { '201': { description: created } } }
components:
  schemas:
    Owner: { type: object }
    Pet: { type: object }
    Visit: { type: object }
`,
};

const ARAZZO: SampleFile = {
  name: "workflow.arazzo.yaml",
  content: `arazzo: 1.0.1
info:
  title: Pet Store workflows
  version: 1.0.0
# x-typespec-source links these workflows back to the TypeSpec contract so the editor
# can trace steps -> endpoints -> entities across the .tsp and .arazzo files.
x-typespec-source: ./main.tsp
sourceDescriptions:
  - name: api
    url: ./openapi.yaml
    type: openapi
workflows:
  - workflowId: onboardCustomer
    summary: Register an owner, add their pet, and book its first visit.
    x-tags: [owners, pets, visits]
    steps:
      - stepId: createOwner
        description: Register the new owner.
        operationId: createOwner
        successCriteria:
          - condition: $statusCode == 201
        outputs:
          ownerId: $response.body#/id
      - stepId: createPet
        description: Add a pet for that owner.
        operationId: createPet
        parameters:
          - name: ownerId
            in: body
            value: $steps.createOwner.outputs.ownerId
        successCriteria:
          - condition: $statusCode == 201
        outputs:
          petId: $response.body#/id
      - stepId: bookVisit
        description: Book the pet's first vet visit.
        operationId: bookVisit
        parameters:
          - name: petId
            in: body
            value: $steps.createPet.outputs.petId
        successCriteria:
          - condition: $statusCode == 201
        outputs:
          visitId: $response.body#/id
    outputs:
      visitId: $steps.bookVisit.outputs.visitId
  - workflowId: findAndBook
    summary: Find an available pet and book a visit for it.
    x-tags: [pets, visits]
    steps:
      - stepId: listPets
        description: List available pets.
        operationId: listPets
        successCriteria:
          - condition: $statusCode == 200
        outputs:
          pets: $response.body
      - stepId: bookVisit
        description: Book a visit for the first pet.
        operationId: bookVisit
        parameters:
          - name: petId
            in: body
            value: $steps.listPets.outputs.pets[0].id
        successCriteria:
          - condition: $statusCode == 201
        outputs:
          visitId: $response.body#/id
    outputs:
      visitId: $steps.bookVisit.outputs.visitId
`,
};

const ASYNCAPI: SampleFile = {
  name: "events.asyncapi.yaml",
  content: `asyncapi: 3.0.0
info:
  title: Pet Store events
  version: 1.0.0
# Each message payload $refs a schema named like a .tsp model, so the editor links
# the channel to that entity; x-operationId binds a channel to an HTTP endpoint.
servers:
  live:
    host: petstore.example.com
    protocol: sse
channels:
  petEvents:
    address: /pets/events
    servers:
      - $ref: '#/servers/live'
    messages:
      petStatusChanged:
        $ref: '#/components/messages/PetStatusChanged'
      petCreated:
        $ref: '#/components/messages/PetCreated'
  visitEvents:
    address: /visits/events
    servers:
      - $ref: '#/servers/live'
    messages:
      visitBooked:
        $ref: '#/components/messages/VisitBooked'
operations:
  receivePetStatusChanged:
    action: receive
    channel:
      $ref: '#/channels/petEvents'
    messages:
      - $ref: '#/channels/petEvents/messages/petStatusChanged'
    x-operationId: getPet
  receivePetCreated:
    action: receive
    channel:
      $ref: '#/channels/petEvents'
    messages:
      - $ref: '#/channels/petEvents/messages/petCreated'
  receiveVisitBooked:
    action: receive
    channel:
      $ref: '#/channels/visitEvents'
    messages:
      - $ref: '#/channels/visitEvents/messages/visitBooked'
    x-operationId: bookVisit
components:
  messages:
    PetStatusChanged:
      summary: A pet's availability status changed.
      payload:
        $ref: '#/components/schemas/Pet'
    PetCreated:
      summary: A new pet was added.
      payload:
        $ref: '#/components/schemas/Pet'
    VisitBooked:
      summary: A visit was booked for a pet.
      payload:
        $ref: '#/components/schemas/Visit'
  schemas:
    Pet:
      type: object
    Visit:
      type: object
`,
};

/**
 * The Pet Store sample, in load order. `main.tsp` is the contract everything else
 * links to, so hosts should open it first.
 */
export const SAMPLE_PROJECT: SampleFile[] = [PRISMA, TSP, OPENAPI, ARAZZO, ASYNCAPI];

/** The file a host should open by default — the contract that drives every tab. */
export const SAMPLE_ENTRYPOINT = "main.tsp";
