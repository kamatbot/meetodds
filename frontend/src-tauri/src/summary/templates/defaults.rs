/// Embedded default templates using compile-time inclusion
///
/// These templates are bundled into the binary and serve as fallbacks
/// when custom templates are not available.

/// Daily standup template for engineering/product teams
pub const DAILY_STANDUP: &str = include_str!("../../../templates/daily_standup.json");

/// Standard meeting notes template
pub const STANDARD_MEETING: &str = include_str!("../../../templates/standard_meeting.json");

/// Mayur's product and KPI operating review
pub const MAYUR_PRODUCT_REVIEW: &str =
    include_str!("../../../templates/mayur_product_review.json");

/// Mayur's mission-linked decision review
pub const MAYUR_DECISION_REVIEW: &str =
    include_str!("../../../templates/mayur_decision_review.json");

/// Mayur's PM one-to-one and coaching review
pub const MAYUR_PM_ONE_ON_ONE: &str =
    include_str!("../../../templates/mayur_pm_one_on_one.json");

/// Registry of all built-in templates
///
/// Maps template identifiers to their embedded JSON content.
pub fn get_builtin_templates() -> Vec<(&'static str, &'static str)> {
    vec![
        ("daily_standup", DAILY_STANDUP),
        ("standard_meeting", STANDARD_MEETING),
        ("mayur_product_review", MAYUR_PRODUCT_REVIEW),
        ("mayur_decision_review", MAYUR_DECISION_REVIEW),
        ("mayur_pm_one_on_one", MAYUR_PM_ONE_ON_ONE),
    ]
}

/// Get a built-in template by identifier
///
/// # Arguments
/// * `id` - Template identifier (for example, "daily_standup")
///
/// # Returns
/// The template JSON content if found, None otherwise.
pub fn get_builtin_template(id: &str) -> Option<&'static str> {
    match id {
        "daily_standup" => Some(DAILY_STANDUP),
        "standard_meeting" => Some(STANDARD_MEETING),
        "mayur_product_review" => Some(MAYUR_PRODUCT_REVIEW),
        "mayur_decision_review" => Some(MAYUR_DECISION_REVIEW),
        "mayur_pm_one_on_one" => Some(MAYUR_PM_ONE_ON_ONE),
        _ => None,
    }
}

/// List all built-in template identifiers.
pub fn list_builtin_template_ids() -> Vec<&'static str> {
    vec![
        "daily_standup",
        "standard_meeting",
        "mayur_product_review",
        "mayur_decision_review",
        "mayur_pm_one_on_one",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_templates_valid_json() {
        for (id, content) in get_builtin_templates() {
            let result = serde_json::from_str::<serde_json::Value>(content);
            assert!(
                result.is_ok(),
                "Built-in template '{}' contains invalid JSON: {:?}",
                id,
                result.err()
            );
        }
    }

    #[test]
    fn test_get_builtin_template() {
        assert!(get_builtin_template("daily_standup").is_some());
        assert!(get_builtin_template("standard_meeting").is_some());
        assert!(get_builtin_template("nonexistent").is_none());
    }

    #[test]
    fn test_mayur_templates_are_registered_and_structurally_valid() {
        let ids = [
            "mayur_product_review",
            "mayur_decision_review",
            "mayur_pm_one_on_one",
        ];

        for id in ids {
            let content = get_builtin_template(id)
                .unwrap_or_else(|| panic!("Mayur template '{}' is not registered", id));
            let template: serde_json::Value = serde_json::from_str(content)
                .unwrap_or_else(|error| panic!("Mayur template '{}' is invalid: {}", id, error));

            assert!(template["name"].as_str().is_some_and(|name| name.starts_with("Mayur")));
            assert!(template["description"].as_str().is_some_and(|value| !value.is_empty()));
            assert!(template["sections"].as_array().is_some_and(|sections| !sections.is_empty()));
        }
    }
}
