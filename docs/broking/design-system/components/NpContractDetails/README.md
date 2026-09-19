# NpContractDetails

The non-proportional contract screen: the Universe NP Treaty Detail **left pane only** (CONTRACT DETAILS), beside the contract's identity. The Universe right pane is not used here — its structure fields move to the Structure screen's programme strip.

**Consumer provides:** the contract (UMR, UUID), reference lists (countries, cedants by country, NP treaty types, classes of business, brokers, currencies), `onSave`.

- Required: Country, Cedant Name, Treaty Type, Classes of Business, Broker, Currency, Treaty Inception Date, Experience Start Year.
- Derived: Contract ID (UUID), UW Year, Treaty Renewal Date (inception + 12 months until edited), Contract Description.
- Treaty Type decides the Structure surface: Risk XL / CAT XL / Risk & CAT XL → layer table; Stop Loss and Aggregate XL → their Universe variants.
