// Adds the Microsoft-Decision-1 deployment to an AIServices account that already exists.
// The account must be in swedencentral, have a custom subdomain and keep local (key) auth enabled.
targetScope = 'resourceGroup'

@description('Name of the existing AIServices account in this resource group.')
@minLength(2)
@maxLength(64)
param accountName string

@description('Deployment name sent as "model" in requests. Must NOT be Microsoft-Decision-1 (reserved word).')
@minLength(1)
@maxLength(64)
param deploymentName string = 'decision-1'

@description('Requests per minute. For this model 1 capacity unit = 1 request per minute.')
@minValue(1)
@maxValue(1000)
param capacityRpm int = 300

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' existing = {
  name: accountName
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: 'DataZoneStandard'
    capacity: capacityRpm
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'Microsoft-Decision-1'
      version: '1'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

@description('Value for the AZURE_DECISION_ENDPOINT secret (uses the account custom subdomain).')
output decisionEndpoint string = 'https://${account.properties.customSubDomainName}.services.ai.azure.com'

@description('Value for the AZURE_DECISION_DEPLOYMENT secret.')
output deploymentName string = decision.name

@description('Region of the account; must be swedencentral for the EU data zone.')
output accountLocation string = account.location
