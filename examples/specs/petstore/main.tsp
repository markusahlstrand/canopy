import "@typespec/http";
import "./models.tsp";

using TypeSpec.Http;

@service(#{ title: "Pet Store" })
namespace PetStore;

@route("/pets")
interface Pets {
  /** List all pets, optionally filtered by species. */
  @get
  @operationId("listPets")
  list(@query species?: Species): Pet[] | Error;

  /** Fetch a single pet by id. */
  @get
  @operationId("getPet")
  get(@path petId: string): Pet | Error;

  /** Register a new pet for adoption. */
  @post
  @operationId("createPet")
  create(@body pet: Pet): Pet | Error;
}

@route("/owners")
interface Owners {
  /** Fetch an owner by id, including their pets. */
  @get
  @operationId("getOwner")
  get(@path ownerId: string): Owner | Error;

  /** Adopt a pet — links an existing pet to an owner. */
  @post
  @operationId("adoptPet")
  adopt(@path ownerId: string, @body petId: string): Owner | Error;
}
