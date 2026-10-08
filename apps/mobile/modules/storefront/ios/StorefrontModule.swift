import ExpoModulesCore
import StoreKit

// App Store rules depend on the storefront (the account's store country), not the device
// region, so the app asks StoreKit. Returns an ISO 3166-1 alpha-3 code such as "USA".
public final class StorefrontModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Storefront")

    AsyncFunction("countryCode") { () async -> String? in
      await Storefront.current?.countryCode
    }
  }
}
