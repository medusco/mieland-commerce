export const typeDefs = /* GraphQL */ `
  enum PricingFieldFormatEnum {
    RAW
    FORMATTED
  }

  enum CountriesEnum {
    US
    NZ
    AU
    GB
    CA
    DE
    FR
    JP
    SG
    OTHER
  }

  enum OrderIdTypeEnum {
    DATABASE_ID
    ID
    ORDER_NUMBER
  }

  enum PostIdType {
    SLUG
    DATABASE_ID
    ID
    URI
  }

  enum PageIdType {
    URI
    DATABASE_ID
    ID
  }

  enum LoginProviderEnum {
    PASSWORD
    GOOGLE
    FACEBOOK
    GITHUB
  }

  enum PostStatusEnum {
    PUBLISH
    DRAFT
    PRIVATE
  }

  type MediaItem {
    sourceUrl: String
    mediaItemUrl: String
    altText: String
  }

  type MediaItemEdge {
    node: MediaItem
  }

  type ProductThumbnailImage {
    node: MediaItem
  }

  type ThumbnailFields {
    productThumbnailImage: ProductThumbnailImage
  }

  type ProductAttribute {
    name: String
    label: String
    options: [String]
  }

  type ProductAttributeConnection {
    nodes: [ProductAttribute]
  }

  type ProductCategory {
    name: String
    slug: String
  }

  type ProductCategoryConnection {
    nodes: [ProductCategory]
  }

  type MediaItemConnection {
    nodes: [MediaItem]
  }

  type CommentAuthor {
    name: String
  }

  type CommentAuthorEdge {
    node: CommentAuthor
  }

  type Comment {
    id: ID
    date: String
    content: String
    karma: Int
    author: CommentAuthorEdge
  }

  type ProductReviewEdge {
    rating: Float
    node: Comment
  }

  type ProductReviews {
    averageRating: Float
    edges: [ProductReviewEdge]
  }

  interface Product {
    databaseId: Int
    name: String
    slug: String
    uri: String
    description: String
    shortDescription: String
    featured: Boolean
    averageRating: Float
    reviewCount: Int
    onSale: Boolean
    image: MediaItem
    thumbnailFields: ThumbnailFields
    productCategories: ProductCategoryConnection
    galleryImages: MediaItemConnection
    reviews: ProductReviews
    title: String
  }

  interface ProductWithAttributes {
    attributes: ProductAttributeConnection
  }

  type ProductVariation {
    databaseId: Int
    name: String
    price(format: PricingFieldFormatEnum): String
    regularPrice(format: PricingFieldFormatEnum): String
    salePrice(format: PricingFieldFormatEnum): String
    onSale: Boolean
    image: MediaItem
  }

  type ProductVariationConnection {
    nodes: [ProductVariation]
  }

  type SimpleProduct implements Product & ProductWithAttributes {
    databaseId: Int
    name: String
    slug: String
    uri: String
    description: String
    shortDescription: String
    featured: Boolean
    averageRating: Float
    reviewCount: Int
    onSale: Boolean
    stockStatus: String
    stockQuantity: Int
    manageStock: Boolean
    image: MediaItem
    thumbnailFields: ThumbnailFields
    attributes: ProductAttributeConnection
    productCategories: ProductCategoryConnection
    galleryImages: MediaItemConnection
    reviews: ProductReviews
    title: String
    price(format: PricingFieldFormatEnum): String
    regularPrice(format: PricingFieldFormatEnum): String
    salePrice(format: PricingFieldFormatEnum): String
  }

  type VariableProduct implements Product & ProductWithAttributes {
    databaseId: Int
    name: String
    slug: String
    uri: String
    description: String
    shortDescription: String
    featured: Boolean
    averageRating: Float
    reviewCount: Int
    onSale: Boolean
    stockStatus: String
    stockQuantity: Int
    manageStock: Boolean
    image: MediaItem
    thumbnailFields: ThumbnailFields
    attributes: ProductAttributeConnection
    productCategories: ProductCategoryConnection
    galleryImages: MediaItemConnection
    reviews: ProductReviews
    title: String
    price(format: PricingFieldFormatEnum): String
    regularPrice(format: PricingFieldFormatEnum): String
    salePrice(format: PricingFieldFormatEnum): String
    variations(first: Int): ProductVariationConnection
  }

  type RootQueryToProductConnection {
    nodes: [Product]
  }

  type MetaData {
    key: String
    value: String
  }

  type CartItemProductEdge {
    node: Product
  }

  type CartItemVariationEdge {
    node: ProductVariation
  }

  type CartItem {
    key: ID
    quantity: Int
    subtotal: String
    extraData: [MetaData]
    product: CartItemProductEdge
    variation: CartItemVariationEdge
  }

  type CartToCartItemConnection {
    itemCount: Int
    nodes: [CartItem]
  }

  type AppliedCoupon {
    code: String
    description: String
    discountAmount: String
    discountTax: String
  }

  type ShippingRate {
    cost: String
    id: String
    instanceId: Int
    label: String
    methodId: String
  }

  type ShippingPackage {
    packageDetails: String
    rates: [ShippingRate]
  }

  type Cart {
    total(format: PricingFieldFormatEnum): String
    subtotal(format: PricingFieldFormatEnum): String
    shippingTotal(format: PricingFieldFormatEnum): String
    totalTax(format: PricingFieldFormatEnum): String
    appliedCoupons: [AppliedCoupon]
    contents: CartToCartItemConnection
    availableShippingMethods: [ShippingPackage]
    chosenShippingMethods: [String]
  }

  type CustomerAddress {
    address1: String
    address2: String
    city: String
    company: String
    country: CountriesEnum
    email: String
    firstName: String
    lastName: String
    phone: String
    postcode: String
    state: String
  }

  type LineItemProductEdge {
    node: Product
  }

  type LineItemVariationEdge {
    node: ProductVariation
  }

  type LineItem {
    databaseId: Int
    productId: Int
    quantity: Int
    subtotal: String
    total: String
    product: LineItemProductEdge
    variation: LineItemVariationEdge
  }

  type LineItemConnection {
    nodes: [LineItem]
  }

  type ShippingLine {
    methodTitle: String
    total: String
  }

  type ShippingLineConnection {
    nodes: [ShippingLine]
  }

  type TaxLine {
    label: String
    taxTotal: String
  }

  type TaxLineConnection {
    nodes: [TaxLine]
  }

  type AmazonMcfTracking {
    trackingNumber: String
    trackingUrl: String
    carrier: String
    status: String
    estimatedArrival: String
  }

  type Order {
    id: ID
    databaseId: Int
    orderNumber: String
    orderKey: String
    status: String
    currency: String
    date: String
    datePaid: String
    total: String
    subtotal: String
    shippingTotal: String
    totalTax: String
    paymentMethod: String
    paymentMethodTitle: String
    transactionId: String
    needsPayment: Boolean
    amazonMcfTrackingCode: String
    amazonMcfTracking: AmazonMcfTracking
    billing: CustomerAddress
    shipping: CustomerAddress
    lineItems: LineItemConnection
    shippingLines: ShippingLineConnection
    taxLines: TaxLineConnection
  }

  type OrderConnection {
    nodes: [Order]
  }

  type Customer {
    id: ID
    databaseId: Int
    email: String
    firstName: String
    lastName: String
    username: String
    sessionToken: String
    billing: CustomerAddress
    shipping: CustomerAddress
    orders: OrderConnection
  }

  type User {
    id: ID
    databaseId: Int
    email: String
    firstName: String
    lastName: String
    username: String
    name: String
  }

  type LoginClient {
    authorizationUrl: String
    isEnabled: Boolean
    name: String
    provider: String
  }

  type MielandSubscriptionDiscount {
    frequency: String
    discountPercent: Float
  }

  type MielandSubscriptionSettings {
    discounts: [MielandSubscriptionDiscount]
  }

  type MielandSubscription {
    id: Int
    status: String
    productId: Int
    variationId: Int
    quantity: Int
    frequency: String
    nextPaymentAt: String
    parentOrderId: Int
    lastOrderId: Int
    lastPaymentError: String
    createdAt: String
    cancelledAt: String
  }

  type Category {
    name: String
    slug: String
    description: String
    count: Int
  }

  type CategoryConnection {
    nodes: [Category]
  }

  type Tag {
    name: String
    slug: String
  }

  type TagConnection {
    nodes: [Tag]
  }

  type AuthorNode {
    name: String
  }

  type AuthorEdge {
    node: AuthorNode
  }

  type FeaturedImageEdge {
    node: MediaItem
  }

  type HoneyGuideFields {
    isFeatured: Boolean
  }

  type Post {
    databaseId: Int
    id: ID
    slug: String
    title: String
    excerpt: String
    content: String
    date: String
    author: AuthorEdge
    categories: CategoryConnection
    tags: TagConnection
    featuredImage: FeaturedImageEdge
    honeyGuideFields: HoneyGuideFields
  }

  type RootQueryToPostConnection {
    nodes: [Post]
  }

  type ContentTemplate {
    templateName: String
  }

  type AcfLink {
    target: String
    title: String
    url: String
  }

  type HomepageHeroBanner {
    promoText: String
    backgroundImage: MediaItemEdge
    backgroundImageMobile: MediaItemEdge
    primaryCta: AcfLink
    secondaryCta: AcfLink
    subtitle: String
    text: String
    title: String
    trustTags: [String]
    videoUrl: MediaItemEdge
  }

  union HomepagePageBlock =
      HomepageFieldsPageBlocksTrustBadgeMarqueeLayout
    | HomepageFieldsPageBlocksTopSellersLayout
    | HomepageFieldsPageBlocksBenefitsSpotlightLayout
    | HomepageFieldsPageBlocksHoneyGuideTilesLayout
    | HomepageFieldsPageBlocksComparisonBlockLayout
    | HomepageFieldsPageBlocksInstagramReelsLayout
    | HomepageFieldsPageBlocksContentTabsLayout
    | HomepageFieldsPageBlocksFaqBlockLayout
    | HomepageFieldsPageBlocksQuizPromoLayout

  type HomepageFieldsPageBlocksTrustBadgeMarqueeLayout {
    fieldGroupName: String
    badges: [HomepageBadge]
  }
  type HomepageBadge {
    icon: String
    title: String
  }
  type HomepageProductIdNode {
    databaseId: Int
  }
  type HomepageProductIdsEdge {
    nodes: [HomepageProductIdNode]
  }
  type HomepageTab {
    productsIds: HomepageProductIdsEdge
    title: String
  }
  type HomepageFieldsPageBlocksTopSellersLayout {
    fieldGroupName: String
    subtitle: String
    tabs: [HomepageTab]
    title: String
  }
  type HomepageIcon {
    icon: String
    subtitle: String
    title: String
  }
  type HomepageFieldsPageBlocksBenefitsSpotlightLayout {
    fieldGroupName: String
    subtitle: String
    ctaLink: AcfLink
    icons: [HomepageIcon]
    title: String
  }
  type HomepageFieldsPageBlocksHoneyGuideTilesLayout {
    fieldGroupName: String
    title: String
    link: AcfLink
  }
  type HomepageFieldsPageBlocksComparisonBlockLayout {
    fieldGroupName: String
    comparisonTable: String
    image: MediaItemEdge
    shopLink: AcfLink
  }
  type HomepageSocialLink {
    icon: String
    link: AcfLink
  }
  type HomepageFieldsPageBlocksInstagramReelsLayout {
    fieldGroupName: String
    subtitle: String
    title: String
    instagramUrl: AcfLink
    socialLinks: [HomepageSocialLink]
  }
  type HomepageFieldsPageBlocksContentTabsLayout {
    fieldGroupName: String
    tabs: [HomepageTab]
  }
  type HomepageFaq {
    answer: String
    question: String
  }
  type HomepageFieldsPageBlocksFaqBlockLayout {
    fieldGroupName: String
    title: String
    questions: [HomepageFaq]
  }
  type HomepageFieldsPageBlocksQuizPromoLayout {
    fieldGroupName: String
    bestSellerProductIds: [Int]
    bestSellerTitle: String
    link: AcfLink
    quizTabTitle: String
    quizText: String
    title: String
  }

  type HomepageFields {
    heroBanner: HomepageHeroBanner
    pageBlocks: [HomepagePageBlock]
  }

  type Page {
    databaseId: Int
    title: String
    slug: String
    content: String
    template: ContentTemplate
    homepageFields: HomepageFields
  }

  type RootQueryToPageConnection {
    nodes: [Page]
  }

  type NavigationFeaturedTile {
    title: String
    link: AcfLink
    image: MediaItemEdge
  }
  type NavigationSubmenuLink {
    link: AcfLink
    linkBadge: String
    submenuTitle: String
  }
  type NavigationSubmenuColumn {
    columnTitle: String
    shopAllLink: AcfLink
    links: [NavigationSubmenuLink]
  }
  type NavigationTopLink {
    featuredTitle: String
    featuredTiles: [NavigationFeaturedTile]
    link: AcfLink
    menuTitle: String
    submenuColumns: [NavigationSubmenuColumn]
  }
  type NavigationTopMenu {
    toplinks: [NavigationTopLink]
  }
  type NavigationFooterColumn {
    footerColumnTitle: String
    links: [NavigationSubmenuLink]
  }
  type NavigationSubscriptionBox {
    buttonTitle: String
    disclaimer: String
    fieldGroupName: String
    subtitle: String
    title: String
  }
  type NavigationTrustBadge {
    image: String
    title: String
  }
  type NavigationFooter {
    fdaDisclousure: String
    footerColumns: [NavigationFooterColumn]
    footerCopyright: String
    socialMediaLinks: [HomepageSocialLink]
    subscriptionBox: NavigationSubscriptionBox
    trustBadges: [NavigationTrustBadge]
  }
  type NavigationFields {
    logoImage: String
    promoText: String
    topMenuCta: AcfLink
  }
  type Navigation {
    id: ID
    pageTitle: String
    menuTitle: String
    topMenu: NavigationTopMenu
    footer: NavigationFooter
    navigationFields: NavigationFields
  }

  type LabReport {
    pdfFile: MediaItemEdge
    reportSubtitle: String
    reportTitle: String
  }
  type LabManualProduct {
    productName: String
    productImage: MediaItemEdge
  }
  type LabResultsFields {
    batchNumber: String
    reports: [LabReport]
    bb: String
    dateOfEntry: String
    dha: String
    npa: String
    glyphoseteTracesFree: String
    hmf: String
    honeyType: String
    leptosperin: String
    manualProduct: LabManualProduct
    mfd: String
    mgo: String
    origin: String
  }
  type LabResultAttachedProduct {
    node: Product
  }
  type LabResult {
    title: String
    databaseId: Int
    labResultsFields: LabResultsFields
    attachedProduct: LabResultAttachedProduct
  }
  type LabResultConnection {
    nodes: [LabResult]
  }

  input ProductQueryInput {
    include: [Int]
    status: String
  }

  input RootQueryToPostConnectionWhereArgs {
    status: PostStatusEnum
    categoryName: String
  }

  input RootQueryToPageConnectionWhereArgs {
    status: PostStatusEnum
  }

  input LabResultsWhereArgs {
    status: PostStatusEnum
    title: String
  }

  input MetaDataInput {
    key: String!
    value: String
  }

  input CustomerAddressInput {
    firstName: String
    lastName: String
    company: String
    address1: String
    address2: String
    city: String
    state: String
    postcode: String
    country: CountriesEnum
    phone: String
    email: String
    overwrite: Boolean
  }

  input AddToCartInput {
    clientMutationId: String
    productId: Int!
    quantity: Int
    variationId: Int
    extraData: String
    calculateShippingTax: Boolean
  }

  input CartItemQuantityInput {
    key: ID!
    quantity: Int!
    extraData: String
  }

  input UpdateItemQuantitiesInput {
    clientMutationId: String
    items: [CartItemQuantityInput]
    calculateShippingTax: Boolean
  }

  input RemoveItemsFromCartInput {
    clientMutationId: String
    keys: [ID]
    calculateShippingTax: Boolean
  }

  input UpdateShippingMethodInput {
    clientMutationId: String
    shippingMethods: [String]
  }

  input ApplyCouponInput {
    clientMutationId: String
    code: String!
    calculateShippingTax: Boolean
  }

  input RemoveCouponsInput {
    clientMutationId: String
    codes: [String]
    calculateShippingTax: Boolean
  }

  input CreateOrderInput {
    clientMutationId: String
    customerId: Int!
  }

  input CheckoutInput {
    clientMutationId: String
    paymentMethod: String
    metaData: [MetaDataInput]
    customerNote: String
    billing: CustomerAddressInput
    shipping: CustomerAddressInput
    shipToDifferentAddress: Boolean
  }

  """
  Pay an existing unpaid order via WooCommerce Store API
  POST /wc/store/v1/checkout/{orderId} (runs gateway process_payment).
  """
  input ProcessOrderPaymentInput {
    clientMutationId: String
    orderId: Int!
    """Order key (wc_order_…). Optional when the API can load it from MySQL."""
    orderKey: String
    """Guest verification email when the order has no customer account."""
    billingEmail: String
    paymentMethod: String
    """
    Store API payment_data key/values. Prefer _stripe_source_id (pm_…) from the shop;
    it is mapped to wc-stripe-payment-method + stripe_source. Do not put UPE type
    slugs like "card" in wc-stripe-payment-method — that key must be the pm_ id.
    """
    paymentData: [MetaDataInput]
  }

  input UpdateCustomerInput {
    clientMutationId: String
    id: ID
    firstName: String
    lastName: String
    email: String
    password: String
    billing: CustomerAddressInput
    shipping: CustomerAddressInput
    shippingSameAsBilling: Boolean
  }

  input RegisterCustomerInput {
    clientMutationId: String
    email: String!
    password: String!
    firstName: String
    lastName: String
    authenticate: Boolean
    billing: CustomerAddressInput
    shipping: CustomerAddressInput
  }

  input SendPasswordResetEmailInput {
    clientMutationId: String
    username: String!
  }

  input PasswordCredentialsInput {
    username: String!
    password: String!
  }

  input OAuthResponseInput {
    code: String!
    state: String
  }

  input LoginInput {
    clientMutationId: String
    provider: LoginProviderEnum!
    credentials: PasswordCredentialsInput
    oauthResponse: OAuthResponseInput
  }

  input RefreshTokenInput {
    clientMutationId: String
    refreshToken: String!
  }

  input UpdateMielandSubscriptionInput {
    clientMutationId: String
    id: Int!
    frequency: String
    quantity: Int
  }

  input CancelMielandSubscriptionInput {
    clientMutationId: String
    id: Int!
  }

  type CartPayload {
    cart: Cart
    clientMutationId: String
  }

  type CreateOrderPayload {
    orderId: Int
    order: Order
    clientMutationId: String
  }

  type CheckoutPayload {
    customer: Customer
    order: Order
    redirect: String
    result: String
    clientMutationId: String
  }

  type ProcessOrderPaymentPayload {
    clientMutationId: String
    order: Order
    """Gateway result: success | failure | pending | error (from Store API)."""
    result: String
    redirect: String
    paymentStatus: String
    paymentDetails: [MetaData]
  }

  type UpdateCustomerPayload {
    customer: Customer
    clientMutationId: String
  }

  type RegisterCustomerPayload {
    authToken: String
    refreshToken: String
    customer: Customer
    clientMutationId: String
  }

  type SendPasswordResetEmailPayload {
    success: Boolean
    user: User
    clientMutationId: String
  }

  type LoginPayload {
    authToken: String
    authTokenExpiration: String
    refreshToken: String
    refreshTokenExpiration: String
    sessionToken: String
    clientMutationId: String
    customer: Customer
    user: User
  }

  type RefreshTokenPayload {
    authToken: String
    authTokenExpiration: String
    refreshToken: String
    refreshTokenExpiration: String
    clientMutationId: String
    success: Boolean
  }

  type UpdateMielandSubscriptionPayload {
    subscription: MielandSubscription
    clientMutationId: String
  }

  type CancelMielandSubscriptionPayload {
    subscription: MielandSubscription
    clientMutationId: String
  }

  type Query {
    cart(recalculateTotals: Boolean, calculateShippingTax: Boolean): Cart
    products(first: Int, where: ProductQueryInput): RootQueryToProductConnection
    customer(id: ID!): Customer
    order(id: ID!, idType: OrderIdTypeEnum): Order
    loginClients: [LoginClient]
    mielandSubscriptionSettings: MielandSubscriptionSettings
    mielandSubscriptions(status: String): [MielandSubscription]
    mielandSubscription(id: Int!): MielandSubscription
    posts(first: Int, where: RootQueryToPostConnectionWhereArgs): RootQueryToPostConnection
    post(id: ID!, idType: PostIdType): Post
    categories(first: Int): CategoryConnection
    pages(first: Int, where: RootQueryToPageConnectionWhereArgs): RootQueryToPageConnection
    page(id: ID!, idType: PageIdType): Page
    navigation: Navigation
    labResults(where: LabResultsWhereArgs): LabResultConnection
  }

  type Mutation {
    addToCart(input: AddToCartInput!): CartPayload
    removeItemsFromCart(input: RemoveItemsFromCartInput!): CartPayload
    updateItemQuantities(input: UpdateItemQuantitiesInput!): CartPayload
    updateShippingMethod(input: UpdateShippingMethodInput!): CartPayload
    applyCoupon(input: ApplyCouponInput!): CartPayload
    removeCoupons(input: RemoveCouponsInput!): CartPayload
    createOrder(input: CreateOrderInput!): CreateOrderPayload
    checkout(input: CheckoutInput!): CheckoutPayload
    processOrderPayment(input: ProcessOrderPaymentInput!): ProcessOrderPaymentPayload
    updateCustomer(input: UpdateCustomerInput!): UpdateCustomerPayload
    registerCustomer(input: RegisterCustomerInput!): RegisterCustomerPayload
    sendPasswordResetEmail(input: SendPasswordResetEmailInput!): SendPasswordResetEmailPayload
    login(input: LoginInput!): LoginPayload
    refreshToken(input: RefreshTokenInput!): RefreshTokenPayload
    updateMielandSubscription(input: UpdateMielandSubscriptionInput!): UpdateMielandSubscriptionPayload
    cancelMielandSubscription(input: CancelMielandSubscriptionInput!): CancelMielandSubscriptionPayload
  }
`;
