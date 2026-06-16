import "@typespec/http";

using TypeSpec.Http;

namespace PetStore;

/** A pet available for adoption. */
model Pet {
  @key id: string;
  name: string;
  species: Species;
  age?: int32;
  /** The owner who adopted this pet, if any. */
  owner?: Owner;
}

/** A person who can adopt pets. */
model Owner {
  @key id: string;
  fullName: string;
  email: string;
  pets: Pet[];
}

enum Species {
  dog,
  cat,
  bird,
}

@error
model Error {
  code: int32;
  message: string;
}
